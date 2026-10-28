use super::*;

// ---------------------------------------------------------------------
// classify: the rule the window applies to every exit.
//
// Pure, so nothing here builds a window or launches a browser. The negative
// cases assert the *decision*, which is the thing that stops the navigation —
// a refused URL never reaches a process launch at all.
// ---------------------------------------------------------------------

fn app(path: &str) -> Url {
    Url::parse(&format!("http://tauri.localhost{path}")).expect("app url")
}

fn dev_server() -> Url {
    Url::parse("http://localhost:5173/").expect("dev url")
}

#[test]
fn the_bundled_app_origin_stays_in_the_window() {
    for path in [
        "/index.html",
        "/#/vpn",
        "/assets/index-abc123.js",
        "/index.html?route=/account",
    ] {
        assert_eq!(classify(&app(path), None), Navigation::InApp, "{path}");
    }
}

#[test]
fn the_https_form_of_the_app_origin_is_the_same_document() {
    // Which scheme the bundled assets use is a build setting (WebView2 serves
    // them over `http://tauri.localhost` by default), and a reload has to keep
    // working whichever one this build uses.
    let https = Url::parse("https://tauri.localhost/index.html").expect("url");
    assert_eq!(classify(&https, None), Navigation::InApp);
}

#[test]
fn the_custom_protocol_origin_stays_in_the_window() {
    // macOS and Linux serve the same assets as `tauri://localhost`.
    let custom = Url::parse("tauri://localhost/index.html").expect("url");
    assert_eq!(classify(&custom, None), Navigation::InApp);
}

#[test]
fn the_dev_server_is_allowed_only_when_the_build_loads_from_it() {
    let dev = dev_server();
    assert_eq!(classify(&dev, Some(&dev)), Navigation::InApp);
    // A fragment/route change on the dev server is the same origin.
    let route = Url::parse("http://localhost:5173/#/vpn").expect("url");
    assert_eq!(classify(&route, Some(&dev)), Navigation::InApp);
    // A release build has no dev origin, so the dev server is just an http URL
    // off-origin — and plaintext http is never opened.
    assert_eq!(classify(&dev, None), Navigation::Refused);
    // A different port is a different origin, even on localhost.
    let other_port = Url::parse("http://localhost:5174/").expect("url");
    assert_eq!(classify(&other_port, Some(&dev)), Navigation::Refused);
}

#[test]
fn an_external_https_url_is_opened_never_loaded() {
    let out = Url::parse("https://t.me/netpulse").expect("url");
    match classify(&out, None) {
        Navigation::External(target) => assert_eq!(target.as_str(), "https://t.me/netpulse"),
        other => panic!("expected External, got {other:?}"),
    }
}

#[test]
fn the_url_handed_to_the_os_is_the_normalised_one() {
    let raw = Url::parse("HTTPS://Telegram.ME/NetPulse").expect("url");
    match classify(&raw, None) {
        Navigation::External(target) => {
            assert_eq!(target.scheme(), "https");
            assert_eq!(target.host_str(), Some("telegram.me"));
        }
        other => panic!("expected External, got {other:?}"),
    }
}

#[test]
fn a_lookalike_host_is_not_the_app() {
    // Host equality, not suffix matching: this is an external site, and the
    // only thing we may do with it is hand it to the browser.
    let lookalike = Url::parse("https://tauri.localhost.evil.example/index.html").expect("url");
    assert_eq!(classify(&lookalike, None), Navigation::External(lookalike.clone()));

    // The same host spelled as userinfo: the parser reads the host as
    // `evil.example`, and the credentials make it unopenable too.
    let userinfo = Url::parse("https://tauri.localhost@evil.example/").expect("url");
    assert_eq!(classify(&userinfo, None), Navigation::Refused);
}

#[test]
fn plaintext_http_is_refused_rather_than_launched() {
    let http = Url::parse("http://example.com/").expect("url");
    assert_eq!(classify(&http, None), Navigation::Refused);
}

#[test]
fn urls_carrying_credentials_are_refused() {
    let creds = Url::parse("https://user:secret@example.com/").expect("url");
    assert_eq!(classify(&creds, None), Navigation::Refused);
}

#[test]
fn non_web_schemes_are_refused() {
    // Everything here either executes script, touches the filesystem, or asks
    // the OS to do something the app never agreed to. None of them is a page.
    for raw in [
        "javascript:alert(1)",
        "file:///C:/Windows/System32/drivers/etc/hosts",
        "data:text/html,<script>alert(1)</script>",
        "mailto:someone@example.com",
        "tel:+10000000000",
        "ms-settings:network",
        "smb://server/share",
        "vbscript:msgbox(1)",
    ] {
        let url = Url::parse(raw).unwrap_or_else(|e| panic!("{raw:?}: {e}"));
        assert_eq!(classify(&url, None), Navigation::Refused, "{raw}");
    }
}

#[test]
fn about_blank_is_the_engines_own_empty_document() {
    let blank = Url::parse("about:blank").expect("url");
    assert_eq!(classify(&blank, None), Navigation::InApp);
}

#[test]
fn an_app_url_is_never_also_opened_externally() {
    // A single decision per navigation: if the app origin also counted as an
    // openable external URL, every reload would spawn a browser tab.
    let dev = dev_server();
    for (url, dev_origin) in [
        (app("/index.html"), None),
        (Url::parse("tauri://localhost/index.html").expect("url"), None),
        (dev.clone(), Some(dev.clone())),
    ] {
        assert_eq!(classify(&url, dev_origin.as_ref()), Navigation::InApp, "{url}");
    }
}
