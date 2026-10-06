# Benchmarks

`npm run bench` (or `npm run bench:windows` from WSL) builds the release core and measures, on the v0 Node engine
and on the Rust core: restoring 5,000 small files, restoring one 1 GB file, a first scan of 50,000 files, and the
core's idle memory and CPU. It runs in a temporary folder on the system drive, and again on any ReFS volume (a Dev
Drive) it finds. Restore times are until every file is in place, when the user is told "restored"; verification
(a fresh scan with full rehash) runs after and is shown in brackets. Each restore starts 30 s after its files were
made, so Windows Defender has finished scanning them, as it would have for a real restore.

Targets (spec §25.2, §28.6): 5,000 files under 5 s; 1 GB under 1 s on the same volume.

## Results (6 Oct 2026)

Windows 11 (10.0.26300) · Intel Core i5-8265U, 4 cores / 8 threads · 8 GB RAM · NTFS (disk model not reported) · Defender
real-time protection on · release build of the core, unsigned · no Dev Drive on this PC.

| Where | Case | Target | v0 engine | Rust core | Target met | Notes |
|---|---|---|---|---|---|---|
| C: (NTFS) | Restore 5,000 small files (folder deleted) | under 5 s | 61.13 s (verified 80.81 s) | 28.65 s (verified 35.17 s) | missed | all 5,000 from the hot cache; the core's own part 23.94 s |
| C: (NTFS) | Restore 5,000 edited files (each old version to the trash) | under 5 s | not run | 84.48 s (verified 93.81 s) | missed | about 17 s of it is v0's before-undo save point |
| C: (NTFS) | Undo that restore (edited versions renamed back from the trash) | under 5 s | not run | 54.37 s (verified 64.81 s) | missed | 10,000 moves between folders, each scanned by Defender |
| C: (NTFS) | Restore one 1 GB file, stored as is (a video) | under 1 s | not run | not run | not run | not enough free disk space (below) |
| C: (NTFS) | Restore one 1 GB file, stored gzipped | under 1 s | not run | not run | not run | not enough free disk space (below) |
| C: (NTFS) | First scan of 50,000 files (hash and store all) | none | 248.82 s | 472.14 s | | Rust ran first, straight after the files were made, while Defender was still scanning them; see below |
| C: (NTFS) | mewndo-core idle, watching the 50,000-file folder (30 s) | under 30 MB (spec §31) | | 4.9 MB working set, 4.4 MB private, 0.05% CPU | met | |

Run to run, the same case varies by up to 2× on this machine: an earlier run of the first row gave v0 54.81 s
and Rust 16.46 s. In the runs that measured both engines, Rust restored 5,000 files 2.1 to 3.3 times faster than v0.

The 50,000-file scan row is not a fair comparison: the Rust scan ran first, while Defender was still scanning the
50,000 files the bench had just made, and v0 ran after it had finished. The bench now waits 30 s before each scan
too; rerun it to compare the engines' scans.

## Why the 5,000-file target is missed on this PC

Measured on the PC above (4 cores, 8 threads, 8 GB, Defender real-time protection on, no Dev Drive).

**Windows Defender scans every file the restore touches, and it is CPU-bound.** During a 5,000-file restore,
Defender (`MsMpEng.exe`) used up to 7.8 of the 8 logical CPUs while `mewndo-core` used under 0.6. More threads
don't help: every file operation waits for a scan. What each step costs, measured with no Mewndo at all (plain
Node, 16 at a time):

| Step, per file | Cost |
|---|---|
| Write a new `.js` file directly | 5.0 ms |
| Write a new `.txt` file directly | 1.0 ms |
| Write a temp file, then rename it to `.js` (what a restore does) | 1.3 ms |
| Open an existing `.js` file again for writing and flush it | 6.7 ms |
| Rename within a folder | 0.2 to 1 ms |

So just creating 5,000 small script files costs about 7 s on this machine, before any of Mewndo's own work.

What was fixed (no safety step removed):

- **Hot cache** (spec §25.2): new content up to 1 MB is also kept uncompressed for 24 hours
  (`<store>/hot/`). Opening the store's gzipped objects was the single biggest cost: Defender unpacks archives
  to scan them. A restore from the hot cache is an OS copy (`CopyFile2`) plus a hash check of the copy. With
  objects uncompressed, the core's part of a 5,000-file restore went from 25 to 30 s down to 13 to 18 s.
- **One handle per staged file**: written, timed and closed once (each extra open costs a scan).
- **Links checked once per folder while staging**, not once per file (5,000 files in 100 folders: 100 checks).
- **The core answers while it works**: slow requests (a 50,000-file scan) now run alongside the app's "are you
  alive" checks. Before, a long scan made the app think the core had hung and restart it (found by this bench).
- Every file still goes to a temp file and is renamed into place, everything replaced still goes to Mewndo's
  trash, and every restore is still verified.

What would meet the target, none of which removes a safety step:

- **A Dev Drive** (opt-in "Turbo restore", spec §28.6): Defender's performance mode scans asynchronously there,
  and copies are block clones. Needs admin rights, 50 GB and a drive other than C:. This PC has none.
- **A signed, packaged build**: v0 measured unsigned builds about 2× slower under Defender.
- **Moving the before-undo save point into the core** (cutover of scanning, after P1.7): for edited files, v0's
  scan and store of the 5,000 changed versions takes about 17 s of the wait.
- An opt-in Defender exclusion for Mewndo's store only (spec §28.6), explained in plain words.

## Why the 1 GB cases didn't run

This PC's C: drive has about 3.5 GB free. The 1 GB cases need the file, its stored copy and 3 GB to spare, so the
bench skips them rather than fill the user's drive. They run on any PC with 5 GB free. Expected from the design:
a video (stored as is) is one `CopyFile2` (a block clone, milliseconds, on a Dev Drive); anything else over 1 MB is
unpacked from gzip, which is bound by decompression speed (about 0.3 to 0.5 GB/s per core), so it will miss the
1 s target outside the hot cache's 1 MB limit.
