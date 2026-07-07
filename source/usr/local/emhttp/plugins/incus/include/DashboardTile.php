<?php
/**
 * Dev-container-status tile — shared between the Incus tab's own summary
 * strip and the optional Main/Dashboard box (IncusDashboard.page). Renders a
 * compact card only; no page chrome. Caller is responsible for the enable check.
 */
require_once __DIR__ . '/IncusHelpers.php';

$healthy = incus_ping();
$containers = $healthy ? incus_list_dev_containers() : [];
$running = count(array_filter($containers, fn($c) => $c['status'] === 'Running'));
$stopped = count($containers) - $running;
?>
<div class="incus-dashboard-tile">
  <div class="incus-tile-title"><i class="fa fa-cube"></i> Incus Dev Containers</div>
  <?php if (!$healthy): ?>
    <div class="incus-tile-error">incusd unreachable</div>
  <?php else: ?>
    <div class="incus-tile-summary">
      <?= count($containers) ?> dev container<?= count($containers) === 1 ? '' : 's' ?>
      &nbsp;(<span class="incus-tile-running"><?= $running ?> running</span>,
      <span class="incus-tile-stopped"><?= $stopped ?> stopped</span>)
    </div>
  <?php endif; ?>
</div>
<style>
.incus-dashboard-tile{padding:8px 12px;}
.incus-tile-title{font-weight:600;margin-bottom:4px;}
.incus-tile-error{color:#c0392b;}
.incus-tile-running{color:#27ae60;}
.incus-tile-stopped{color:#888;}
</style>
