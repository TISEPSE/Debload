// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Relancé en root par pkexec, le binaire ne sert plus d'interface : il
    // écoute les opérations privilégiées sur ses tuyaux hérités.
    if std::env::args().nth(1).as_deref() == Some(debload_lib::privileged::HELPER_FLAG) {
        debload_lib::privileged::helper_main();
        return;
    }

    debload_lib::run()
}
