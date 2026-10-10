// §36.6 U7: Mewndo's Cua wrapper against Cua's own golden trajectories.
//
// third_party/cua/cursor-motion-golden.json is a subset of the fixture Cua tests its own planner and its TypeScript
// port against (its `_provenance` says which commit, which file, its SHA-256 and what was dropped). Each case is a
// style, a timing and one of four canonical moves, with the trajectory sampled at 25 evenly spaced times. If the
// wrapper converted a field wrongly -- a heading, the seed, the target rectangle, seconds for milliseconds -- these
// points would not match.
//
// Runs only with the `cua-motion` feature (Cargo.toml, `required-features`), because only that feature builds Cua.

use mewndo_overlay::coords::Px;
use mewndo_overlay::cua_motion::CuaPlanner;
use mewndo_overlay::motion::{MotionPlanner, MoveRequest, duration, sample_at, wrap_angle};
use serde_json::Value;

/// The fixture is rounded to 1e-9; this leaves room for that and nothing a wrong conversion could hide in.
const CLOSE: f64 = 1e-6;
/// The commit the dependency is pinned to in core/Cargo.toml.
const PINNED: &str = "5a364bbe60e1f8a901ceacd889606b6367dc96ab";

fn golden() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../third_party/cua/cursor-motion-golden.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap()
}

fn pt(v: &Value) -> Px {
    Px::new(f(&v[0]), f(&v[1]))
}

#[test]
fn the_fixture_is_the_one_the_dependency_is_pinned_to() {
    let g = golden();
    let p = &g["_provenance"];
    assert_eq!(
        p["source_commit"], PINNED,
        "the fixture and the git dependency must come from the same Cua commit"
    );
    assert_eq!(
        p["copied_from"],
        "libs/cua-driver/rust/crates/cua-cursor-motion/fixtures/golden.json"
    );
    assert_eq!(
        p["kept_cases"].as_u64().unwrap() as usize,
        g["cases"].as_array().unwrap().len()
    );
    assert_eq!(g["grid"], 24);
}

#[test]
fn every_golden_case_matches_the_wrapper() {
    let g = golden();
    let grid = g["grid"].as_u64().unwrap() as usize;
    let cases = g["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 48, "six styles x two timings x four moves");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let planner = CuaPlanner::new(
            case["style"].as_str().unwrap(),
            case["timing"].as_str().unwrap(),
        )
        .unwrap_or_else(|| panic!("{name}: a style or timing Cua does not know"));
        let r = &case["request"];
        let request = MoveRequest {
            from: pt(&r["from"]),
            from_heading: f(&r["from_heading"]),
            to: pt(&r["to"]),
            end_heading: f(&r["end_heading"]),
            target: r["target"]
                .as_array()
                .map(|t| [f(&t[0]), f(&t[1]), f(&t[2]), f(&t[3])]),
            seed: r["seed"].as_str().unwrap().to_string(),
            reduced_motion: r["reduced_motion"].as_bool().unwrap(),
        };
        let samples = planner.plan(&request);
        assert_eq!(
            samples.len() as u64,
            case["samples"].as_u64().unwrap(),
            "{name}: sample count"
        );
        let d = duration(&samples);
        assert!(
            (d - f(&case["duration"])).abs() < CLOSE,
            "{name}: duration {d}"
        );

        let want = case["grid"].as_array().unwrap();
        assert_eq!(want.len(), grid + 1, "{name}");
        for (i, w) in want.iter().enumerate() {
            let s = sample_at(&samples, d * i as f64 / grid as f64);
            let (t, x, y, heading) = (f(&w[0]), f(&w[1]), f(&w[2]), f(&w[3]));
            assert!(
                (s.t - t).abs() < CLOSE
                    && (s.x - x).abs() < CLOSE
                    && (s.y - y).abs() < CLOSE
                    && wrap_angle(s.heading - heading).abs() < CLOSE,
                "{name} point {i}: got [{}, {}, {}, {}], Cua's fixture says [{t}, {x}, {y}, {heading}]",
                s.t,
                s.x,
                s.y,
                s.heading
            );
        }
    }
}
