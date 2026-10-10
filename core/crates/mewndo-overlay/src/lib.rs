//! The agent cursor: one transparent topmost window per display (spec §36.6 U7).
//!
//! When the core allows an agent's act at a point, the user sees a second cursor -- Mewndo's, not theirs -- glide to
//! that point with a label chip beside it ("Claude · clicking"), so they can always tell their own pointer from the
//! agent's and see what the agent is about to do. cua-driver's own cursor is switched off (§36.6 U8, in
//! mewndo-computer) so only one agent cursor is ever on screen; when that switch fails the overlay draws the label
//! chip alone, next to the driver's cursor.
//!
//! - `coords` turns a cua-driver point into a virtual-screen point (pure, tested).
//! - `motion` plans the glide (`MotionPlanner`, a built-in planner; tested), and `cua_motion` puts Cua's own planner
//!   behind the same trait with the non-default `cua-motion` feature.
//! - `window` is the Windows part: the windows, the drawing, the animation. A no-op elsewhere.
//!
//! What it can't do (CLAUDE.md rule 5):
//!
//! - It shows where the agent acts; it does not stop anything. The guard is the core's card (§36.6 U5).
//! - It cannot place an act it has no target for (a pixel act without `target`, another display) or a window whose
//!   `window_id` is not a live window of that process; those move no cursor rather than a wrong one.
//! - The move starts when the core allows the act, and the driver acts as soon as the proxy hears that, so a long
//!   glide can still be arriving after the click has landed.
//! - A capped desktop capture (`max_image_dimension`) is placed as if it were full size: the core does not know the
//!   cap the agent chose.
//! - The window code is compile-checked for Windows only; it has not been run on Windows.

pub mod coords;
#[cfg(feature = "cua-motion")]
pub mod cua_motion;
pub mod motion;
pub mod window;

use std::sync::mpsc;

/// One thing for the overlay to show: the agent cursor going to an act's point.
#[derive(Debug, Clone, PartialEq)]
pub struct Show {
    /// The act's point as cua-driver gets it, in its target's space (coords.rs).
    pub at: coords::Px,
    pub target: coords::Target,
    /// "Claude · clicking".
    pub label: String,
    /// Draw the arrow. False when cua-driver's own cursor is still showing (§36.6 U8 fell back): the chip only.
    pub arrow: bool,
}

/// The core's handle on the overlay. Cheap to keep; dropping it closes the windows.
pub struct Overlay {
    tx: mpsc::Sender<Show>,
    wake: Box<dyn Fn() + Send + Sync>,
}

impl Overlay {
    /// Starts the overlay's own thread and its windows, one per display. On Windows an error means no window could be
    /// made. Elsewhere there is nothing to draw on, and the handle it returns shows nothing.
    pub fn start() -> Result<Overlay, String> {
        let (tx, rx) = mpsc::channel();
        let wake = window::spawn(rx, motion::default_planner())?;
        Ok(Overlay { tx, wake })
    }

    /// A handle whose requests arrive on the returned receiver instead of on screen: for testing what drives it.
    pub fn channel() -> (Overlay, mpsc::Receiver<Show>) {
        let (tx, rx) = mpsc::channel();
        (
            Overlay {
                tx,
                wake: Box::new(|| {}),
            },
            rx,
        )
    }

    /// Move the agent cursor to an act. Never blocks: the overlay thread animates it.
    pub fn show(&self, show: Show) {
        if self.tx.send(show).is_ok() {
            (self.wake)();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_show_reaches_the_overlay_thread_unchanged() {
        let (overlay, rx) = Overlay::channel();
        let show = Show {
            at: coords::Px::new(412.0, 230.0),
            target: coords::Target::Desktop,
            label: "Claude · clicking".into(),
            arrow: true,
        };
        overlay.show(show.clone());
        assert_eq!(rx.try_recv().unwrap(), show);
        drop(rx);
        overlay.show(show); // the overlay is gone: no panic
    }

    #[test]
    fn off_windows_the_overlay_starts_and_draws_nothing() {
        if cfg!(windows) {
            return;
        }
        let overlay = Overlay::start().unwrap();
        overlay.show(Show {
            at: coords::Px::new(1.0, 2.0),
            target: coords::Target::Desktop,
            label: String::new(),
            arrow: true,
        });
    }
}
