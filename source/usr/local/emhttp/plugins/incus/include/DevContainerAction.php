<?php
/** AJAX endpoint for dev container lifecycle buttons on the Incus tab (start/stop/restart/delete). */
require_once '/usr/local/emhttp/webGui/include/Wrappers.php';
require_once __DIR__ . '/IncusHelpers.php';

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');
incus_require_post();
incus_require_csrf();

$name = $_POST['name'] ?? '';
$action = $_POST['action'] ?? '';
if ($name === '' || $action === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'missing name/action']);
    exit;
}
if (!incus_validate_dev_container_name($name)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid dev container name']);
    exit;
}

$resp = $action === 'delete' ? incus_delete_dev_container($name) : incus_set_dev_container_state($name, $action);
echo json_encode($resp);
