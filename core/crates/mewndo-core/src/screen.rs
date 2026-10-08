// Is a full-screen app (a game, a video, a presentation) in front? The Mewndo bar hides then (spec §23.5).
// Windows' own answer, the one it uses to hold back notifications: SHQueryUserNotificationState.

/// True while a full-screen app, a Direct3D full-screen game or presentation mode is in front.
#[cfg(windows)]
pub fn full_screen() -> bool {
    use windows_sys::Win32::UI::Shell::{
        QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN,
        SHQueryUserNotificationState,
    };
    let mut state = 0;
    // SAFETY: one out-parameter, a plain integer we own.
    let ok = unsafe { SHQueryUserNotificationState(&mut state) } >= 0;
    ok && [
        QUNS_BUSY,
        QUNS_RUNNING_D3D_FULL_SCREEN,
        QUNS_PRESENTATION_MODE,
    ]
    .contains(&state)
}

#[cfg(not(windows))]
pub fn full_screen() -> bool {
    false // ponytail: Mewndo v1 is a Windows app
}

#[cfg(test)]
mod tests {
    #[test]
    fn answers_without_failing() {
        // A test run has no full-screen app in front of it on a build machine; this only checks the call works.
        let _ = super::full_screen();
    }
}
