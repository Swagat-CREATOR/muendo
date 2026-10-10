// §36.6 U7: where on the screen a cua-driver point is.
//
// cua-driver speaks physical pixels on Windows: it is per-monitor-v2 DPI aware, so screenshots and pixel clicks share
// one space with no logical-pixel layer (docs/decisions.md, "cua-driver" 2). The overlay is per-monitor-v2 aware
// too, so there is no DPI sum here. What differs is the origin, and it depends on the act's `target`:
//
//   target.kind = "window"   window-client pixels: (0, 0) is the top-left of the window's client area, the
//                            screenshot the agent saw. The driver calls ClientToScreen itself; this is the same sum.
//   target.kind = "desktop"  native `get_desktop_state` screenshot pixels of the primary display. A capture the agent
//                            capped with `max_image_dimension` is smaller than the display, and the driver scales a
//                            point from it back up; this does the same, but only when it is told the capture size.
//
// The answer is a virtual-screen point: the space that spans every monitor, where a monitor to the left of or above
// the primary one has negative coordinates.
//
// Pure, so every case is tested on any machine. The two facts it needs from Windows -- a window's client origin and
// the monitor rectangles -- are looked up by window.rs.

use serde_json::Value;

/// A point in physical pixels. Which space it is in depends on where it came from; see each function.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Px {
    pub x: f64,
    pub y: f64,
}

impl Px {
    pub const fn new(x: f64, y: f64) -> Px {
        Px { x, y }
    }
}

/// A rectangle in virtual-screen pixels, right and bottom exclusive (Windows' RECT).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    pub fn contains(&self, p: Px) -> bool {
        p.x >= self.left as f64
            && p.x < self.right as f64
            && p.y >= self.top as f64
            && p.y < self.bottom as f64
    }

    /// How far `p` is from this rectangle, squared; 0 inside it.
    fn distance2(&self, p: Px) -> f64 {
        let dx = (self.left as f64 - p.x)
            .max(p.x - (self.right - 1) as f64)
            .max(0.0);
        let dy = (self.top as f64 - p.y)
            .max(p.y - (self.bottom - 1) as f64)
            .max(0.0);
        dx * dx + dy * dy
    }
}

/// What an act's point is relative to: the `target` argument cua-driver requires on a pixel act
/// (docs/decisions.md, "cua-driver" 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// `{kind: "window", pid, window_id}`.
    Window { pid: u32, window_id: u64 },
    /// `{kind: "desktop", display_id: "primary"}`, the only portable desktop target in cua-driver 0.34.0.
    Desktop,
}

impl Target {
    /// The act's target, from its arguments as the core sees them (redaction leaves `target` alone). None when there
    /// is no target, or one the overlay cannot place: another display, which the driver itself rejects, or a kind
    /// this version does not know. No guess is made: an unplaced act moves no cursor.
    pub fn from_args(args: &Value) -> Option<Target> {
        let target = args.get("target")?;
        match target.get("kind")?.as_str()? {
            "window" => Some(Target::Window {
                pid: u32::try_from(target.get("pid")?.as_u64()?).ok()?,
                window_id: target.get("window_id")?.as_u64()?,
            }),
            "desktop" if target.get("display_id")?.as_str()? == "primary" => Some(Target::Desktop),
            _ => None,
        }
    }
}

/// Where a target's (0, 0) is, in virtual-screen pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Origin {
    /// The top-left of the window's client area: `ClientToScreen(hwnd, (0, 0))` from a per-monitor-v2 thread.
    Window(Px),
    /// The primary display, and the size in pixels of the capture the point was read from when the agent capped it.
    /// `None` means a native capture, the same size as the display.
    Desktop {
        primary: Rect,
        capture: Option<(u32, u32)>,
    },
}

/// A cua-driver point, in its target's space, as a virtual-screen point.
pub fn to_virtual(p: Px, origin: Origin) -> Px {
    match origin {
        Origin::Window(o) => Px::new(o.x + p.x, o.y + p.y),
        Origin::Desktop { primary, capture } => {
            let (sx, sy) = match capture {
                Some((w, h)) if w > 0 && h > 0 => (
                    primary.width() as f64 / w as f64,
                    primary.height() as f64 / h as f64,
                ),
                _ => (1.0, 1.0),
            };
            Px::new(
                primary.left as f64 + p.x * sx,
                primary.top as f64 + p.y * sy,
            )
        }
    }
}

/// Which monitor shows `p`: the one containing it, else the nearest (a point in the gap between two monitors, or
/// just off the edge). None only with no monitors at all.
pub fn monitor_at(p: Px, monitors: &[Rect]) -> Option<usize> {
    if let Some(i) = monitors.iter().position(|m| m.contains(p)) {
        return Some(i);
    }
    (0..monitors.len()).min_by(|&a, &b| {
        monitors[a]
            .distance2(p)
            .total_cmp(&monitors[b].distance2(p))
    })
}

/// `p` relative to a monitor's top-left: where to draw it in that monitor's overlay window.
pub fn local(p: Px, monitor: Rect) -> Px {
    Px::new(p.x - monitor.left as f64, p.y - monitor.top as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PRIMARY: Rect = Rect {
        left: 0,
        top: 0,
        right: 2560,
        bottom: 1440,
    };
    /// A 1080p monitor to the left of the primary one: every x on it is negative.
    const LEFT: Rect = Rect {
        left: -1920,
        top: 200,
        right: 0,
        bottom: 1280,
    };
    /// A monitor above the primary one, with a gap between them.
    const ABOVE: Rect = Rect {
        left: 300,
        top: -1100,
        right: 2220,
        bottom: -20,
    };

    #[test]
    fn a_window_point_is_offset_by_the_client_origin_even_when_it_is_negative() {
        // A window on the left monitor: ClientToScreen gave (-1500, 260).
        let origin = Origin::Window(Px::new(-1500.0, 260.0));
        assert_eq!(
            to_virtual(Px::new(10.0, 20.0), origin),
            Px::new(-1490.0, 280.0)
        );
        assert_eq!(
            to_virtual(Px::new(0.0, 0.0), origin),
            Px::new(-1500.0, 260.0)
        );
        // A window on a monitor above: negative y.
        let above = Origin::Window(Px::new(400.0, -900.0));
        assert_eq!(to_virtual(Px::new(5.5, 7.5), above), Px::new(405.5, -892.5));
    }

    #[test]
    fn a_desktop_point_is_on_the_primary_display_and_a_capped_capture_is_scaled_back() {
        let native = Origin::Desktop {
            primary: PRIMARY,
            capture: None,
        };
        assert_eq!(
            to_virtual(Px::new(100.0, 50.0), native),
            Px::new(100.0, 50.0)
        );
        // max_image_dimension 1280: the agent saw a 1280x720 picture of a 2560x1440 display.
        let capped = Origin::Desktop {
            primary: PRIMARY,
            capture: Some((1280, 720)),
        };
        assert_eq!(
            to_virtual(Px::new(100.0, 50.0), capped),
            Px::new(200.0, 100.0)
        );
        // A nonsense capture size is treated as native rather than dividing by zero.
        let zero = Origin::Desktop {
            primary: PRIMARY,
            capture: Some((0, 720)),
        };
        assert_eq!(to_virtual(Px::new(3.0, 4.0), zero), Px::new(3.0, 4.0));
    }

    #[test]
    fn the_monitor_for_a_point_is_the_one_holding_it_or_the_nearest() {
        let monitors = [PRIMARY, LEFT, ABOVE];
        assert_eq!(monitor_at(Px::new(10.0, 10.0), &monitors), Some(0));
        assert_eq!(monitor_at(Px::new(-1.0, 300.0), &monitors), Some(1));
        assert_eq!(monitor_at(Px::new(-1920.0, 200.0), &monitors), Some(1));
        assert_eq!(monitor_at(Px::new(500.0, -1100.0), &monitors), Some(2));
        // Right and bottom edges are exclusive: (0, 300) is the primary's, not the left monitor's.
        assert_eq!(monitor_at(Px::new(0.0, 300.0), &monitors), Some(0));
        // In the 20-pixel gap above the primary, nearer the monitor above.
        assert_eq!(monitor_at(Px::new(500.0, -15.0), &monitors), Some(2));
        assert_eq!(monitor_at(Px::new(500.0, -5.0), &monitors), Some(0));
        // Off every edge: the nearest still draws it, at its edge.
        assert_eq!(monitor_at(Px::new(-5000.0, 700.0), &monitors), Some(1));
        assert_eq!(monitor_at(Px::new(1.0, 1.0), &[]), None);
    }

    #[test]
    fn local_is_relative_to_the_monitors_top_left() {
        assert_eq!(local(Px::new(-1490.0, 280.0), LEFT), Px::new(430.0, 80.0));
        assert_eq!(local(Px::new(500.0, -1000.0), ABOVE), Px::new(200.0, 100.0));
        assert_eq!(local(Px::new(7.0, 9.0), PRIMARY), Px::new(7.0, 9.0));
    }

    #[test]
    fn targets_are_read_from_the_acts_arguments() {
        assert_eq!(
            Target::from_args(
                &json!({"x": 1, "target": {"kind": "window", "pid": 6004, "window_id": 131_844}})
            ),
            Some(Target::Window {
                pid: 6004,
                window_id: 131_844
            })
        );
        assert_eq!(
            Target::from_args(&json!({"target": {"kind": "desktop", "display_id": "primary"}})),
            Some(Target::Desktop)
        );
        for unplaced in [
            json!({"x": 1, "y": 2}),
            json!({"target": {"kind": "desktop", "display_id": "\\\\.\\DISPLAY2"}}),
            json!({"target": {"kind": "window", "pid": 4}}),
            json!({"target": {"kind": "window", "pid": -1, "window_id": 3}}),
            json!({"target": {"kind": "screen"}}),
            json!({"target": "primary"}),
        ] {
            assert_eq!(Target::from_args(&unplaced), None, "{unplaced}");
        }
    }
}
