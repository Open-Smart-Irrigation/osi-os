<?php
/**
 * Plugin Name: OSI Public Simulator Invitation
 * Description: Adds the compact simulator invitation to the site homepage.
 */

if (!defined('ABSPATH')) {
    exit;
}

$osi_simulator_release = 'v2-REPLACE_WITH_REVIEWED_SOURCE_COMMIT';
if (!preg_match('/\Av2-[a-f0-9]{40}\z/', $osi_simulator_release)) {
    return;
}

add_action('wp_enqueue_scripts', function () use ($osi_simulator_release) {
    if (is_admin()) {
        return;
    }

    $osi_simulator_base = content_url('/uploads/osi-os-demo/' . $osi_simulator_release . '/');
    if (is_front_page()) {
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
    }

    $post = get_post();
    if ($post && has_shortcode($post->post_content, 'osi_simulator_cta')) {
        wp_enqueue_style('osi-public-simulator-cta', $osi_simulator_base . 'cta.css', array(), $osi_simulator_release);
    }
}, 20);

add_shortcode('osi_simulator_cta', function () {
    $simulator_url = esc_url(home_url('/simulator/'));
    $about_url = esc_url(home_url('/osi-system/'));
    return '<section class="osi-simulator-cta" aria-labelledby="osi-simulator-cta-title">'
        . '<div class="osi-simulator-cta__copy"><h2 id="osi-simulator-cta-title">Explore OSI OS</h2>'
        . '<p>See irrigation zones, sensor readings, valve controls and schedules in the OSI OS dashboard.</p></div>'
        . '<div class="osi-simulator-cta__actions"><a class="osi-simulator-cta__primary" href="' . $simulator_url . '">Try the OSI OS simulator</a>'
        . '<a class="osi-simulator-cta__secondary" href="' . $about_url . '">About OSI OS</a></div></section>';
});

add_filter('script_loader_tag', function ($tag, $handle, $src) {
    if ($handle !== 'osi-public-simulator-invitation') {
        return $tag;
    }

    return '<script src="' . esc_url($src) . '" defer></script>';
}, 10, 3);
