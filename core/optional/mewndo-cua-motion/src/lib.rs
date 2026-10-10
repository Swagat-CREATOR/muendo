// §36.6 U7: Cua's cursor motion behind Mewndo's `MotionPlanner`, so the agent cursor Mewndo draws moves the way
// cua-driver's own cursor would have (§36.6 U8 switches that one off).
//
// This is the only file that names `cua-cursor-motion`, a git dependency pinned in this crate's Cargo.toml to commit
// 5a364bbe60e1f8a901ceacd889606b6367dc96ab of https://github.com/trycua/cua (MIT; credit and licence in
// third_party/cua/). The crate sits outside the workspace (core/Cargo.toml `exclude`) so that no ordinary build or
// CI run fetches Cua's repository (a 367 MB git database): only building this crate does. Its API, read from that commit,
// is written down in docs/decisions.md, "cua-driver" 5. No Cua source is copied here: this calls `plan_move` and
// converts the types both ways.
//
// What it can't do: the trail, glow, magnet and ripple effects Cua's planner also describes are not drawn (the
// overlay draws an arrow and a label chip), and `MotionParams` beyond style and timing stay at Cua's defaults.
//
// tests/golden_paths.rs checks this wrapper against Cua's own golden trajectories.

use cua_cursor_motion as cua;
use mewndo_overlay::motion::{MotionPlanner, MoveRequest, Sample};

/// Cua's planner with one style and one timing, every other parameter at Cua Driver's defaults.
pub struct CuaPlanner {
    params: cua::MotionParams,
}

impl CuaPlanner {
    /// A style (`signature_arc`, `spring_settle`, `magnetic`, `comet_swoop`, `adaptive`, `classic`) and a timing
    /// (`native`, `fitts`, `fixed`) by Cua's own names; None for a name Cua does not know.
    pub fn new(style: &str, timing: &str) -> Option<CuaPlanner> {
        Some(CuaPlanner {
            params: cua::MotionParams {
                style: cua::MotionStyle::parse(style)?,
                timing: cua::MotionTiming::parse(timing)?,
                ..cua::MotionParams::default()
            },
        })
    }

    /// The style's and timing's names, as `new` takes them.
    pub fn names(&self) -> (&'static str, &'static str) {
        (self.params.style.as_str(), self.params.timing.as_str())
    }
}

impl Default for CuaPlanner {
    /// Cua Driver's own default: `signature_arc`, `native` timing.
    fn default() -> CuaPlanner {
        CuaPlanner {
            params: cua::MotionParams::default(),
        }
    }
}

impl MotionPlanner for CuaPlanner {
    fn plan(&self, r: &MoveRequest) -> Vec<Sample> {
        let request = cua::MoveRequest {
            from: cua::Pt::new(r.from.x, r.from.y),
            from_heading: r.from_heading,
            to: cua::Pt::new(r.to.x, r.to.y),
            end_heading: r.end_heading,
            target: r.target,
            seed: r.seed.clone(),
            reduced_motion: r.reduced_motion,
        };
        cua::plan_move(&self.params, &request)
            .samples
            .into_iter()
            .map(|s| Sample {
                t: s.t,
                x: s.x,
                y: s.y,
                heading: s.heading,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mewndo_overlay::coords::Px;

    #[test]
    fn names_round_trip_and_unknown_ones_are_refused() {
        assert_eq!(CuaPlanner::default().names(), ("signature_arc", "native"));
        assert_eq!(
            CuaPlanner::new("comet_swoop", "fitts").unwrap().names(),
            ("comet_swoop", "fitts")
        );
        assert!(CuaPlanner::new("loop_the_loop", "native").is_none());
        assert!(CuaPlanner::new("classic", "slow").is_none());
    }

    #[test]
    fn a_plan_starts_at_zero_and_ends_at_the_act() {
        let s = CuaPlanner::default().plan(&MoveRequest::new(
            Px::new(-1200.0, 300.0),
            Px::new(640.0, 360.0),
        ));
        assert_eq!(s[0].t, 0.0);
        let end = s.last().unwrap();
        assert!((end.x - 640.0).abs() < 1e-6 && (end.y - 360.0).abs() < 1e-6);
    }
}
