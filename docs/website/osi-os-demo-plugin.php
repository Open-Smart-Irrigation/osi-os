<?php
/**
 * Plugin Name: OSI Public Simulator Invitation
 * Description: Adds the compact simulator invitation to the site homepage.
 */

if (!defined('ABSPATH')) {
    exit;
}

$osi_simulator_release = 'v1-REPLACE_WITH_REVIEWED_SOURCE_COMMIT';
if (!preg_match('/\Av1-[a-f0-9]{40}\z/', $osi_simulator_release)) {
    return;
}

add_action('wp_enqueue_scripts', function () use ($osi_simulator_release) {
    if (is_admin() || !is_front_page()) {
        return;
    }

    $osi_simulator_base = content_url('/uploads/osi-os-demo/' . $osi_simulator_release . '/');
    wp_enqueue_style(
        'osi-public-simulator-invitation',
        $osi_simulator_base . 'invitation.css',
        array(),
        $osi_simulator_release
    );
    wp_enqueue_script(
        'osi-public-simulator-invitation',
        $osi_simulator_base . 'invitation.js',
        array(),
        $osi_simulator_release,
        true
    );
}, 20);

add_filter('script_loader_tag', function ($tag, $handle, $src) {
    if ($handle !== 'osi-public-simulator-invitation') {
        return $tag;
    }

    return '<script src="' . esc_url($src) . '" defer></script>';
}, 10, 3);
