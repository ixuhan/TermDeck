pub mod commands;
pub mod fsview;
pub mod history;
pub mod logging;
pub mod models;
pub mod pty;
pub mod utf8;
pub mod workspace;

use tauri::Manager;

pub struct AppState {
    pub pty: pty::PtyManager,
    pub history: history::HistoryStore,
    pub paths: workspace::AppPaths,
}

pub fn run() {
    tauri::Builder::default()
        // Updater checks the endpoint on demand; nothing runs in the
        // background unless the UI asks for it.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let fallback = app
                .path()
                .app_data_dir()
                .expect("cannot resolve app data dir");
            // Data lives next to the executable (`<exe>/data`) so the whole app
            // is self-contained and portable; read-only installs fall back to
            // the roaming profile.
            let dir = workspace::resolve_data_dir(fallback);
            std::fs::create_dir_all(&dir)?;

            let paths = workspace::AppPaths::new(dir);
            logging::init(paths.dir());
            logging::info(format!("app starting, data dir = {}", paths.dir().display()));
            let history = history::HistoryStore::open(&paths.db())?;

            app.manage(AppState {
                pty: pty::PtyManager::new(),
                history,
                paths,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_session,
            commands::write_pty,
            commands::resize_pty,
            commands::kill_session,
            commands::session_alive,
            commands::pty_attach,
            commands::history_add,
            commands::history_prefix,
            commands::history_search,
            commands::history_recent,
            commands::history_clear,
            commands::history_commands,
            commands::workspace_load,
            commands::workspace_save,
            commands::presets_load,
            commands::presets_save,
            commands::settings_load,
            commands::settings_save,
            commands::install_kind,
            commands::data_dir,
            commands::open_data_dir,
            commands::export_quick_commands,
            commands::list_quick_command_exports,
            commands::import_quick_commands,
            commands::read_directory,
            commands::open_path,
            commands::detect_shells,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let state = window.state::<AppState>();
                state.pty.kill_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running TermDeck");
}
