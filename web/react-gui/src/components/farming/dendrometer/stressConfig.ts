import type { StressLevel, IrrigationAction } from '../../../types/farming';

export interface StressConfig {
  label: string;
  dots: number;
  /** Tailwind border colour class — used as left accent stripe on tree cards */
  border: string;
  /** Tailwind background colour for badges */
  badgeBg: string;
  /** Tailwind text colour for badges */
  badgeText: string;
  /** Hex for SVG / recharts elements */
  hex: string;
  /** Lighter hex for chart fills */
  hexLight: string;
}

export const STRESS_CONFIG: Record<StressLevel, StressConfig> = {
  none: {
    label: 'No Stress',
    dots: 1,
    border: 'border-l-green-500',
    badgeBg: 'bg-green-100',
    badgeText: 'text-green-800',
    hex: '#16a34a',
    hexLight: '#dcfce7',
  },
  mild: {
    label: 'Mild',
    dots: 2,
    border: 'border-l-amber-500',
    badgeBg: 'bg-amber-100',
    badgeText: 'text-amber-800',
    hex: '#d97706',
    hexLight: '#fef3c7',
  },
  moderate: {
    label: 'Moderate',
    dots: 3,
    border: 'border-l-orange-500',
    badgeBg: 'bg-orange-100',
    badgeText: 'text-orange-700',
    hex: '#ea580c',
    hexLight: '#ffedd5',
  },
  significant: {
    label: 'High Stress',
    dots: 4,
    border: 'border-l-red-500',
    badgeBg: 'bg-red-100',
    badgeText: 'text-red-800',
    hex: '#dc2626',
    hexLight: '#fee2e2',
  },
  severe: {
    label: 'SEVERE',
    dots: 5,
    border: 'border-l-red-900',
    badgeBg: 'bg-red-200',
    badgeText: 'text-red-950',
    hex: '#7f1d1d',
    hexLight: '#fecaca',
  },
};

export interface ActionConfig {
  label: string;
  icon: string;
  /** Tailwind background for the banner */
  bannerBg: string;
  bannerText: string;
  bannerBorder: string;
}

export const ACTION_CONFIG: Record<IrrigationAction, ActionConfig> = {
  decrease_10: {
    label: 'Decrease irrigation −10%',
    icon: '↓',
    bannerBg: 'bg-green-50',
    bannerText: 'text-green-900',
    bannerBorder: 'border-green-400',
  },
  maintain: {
    label: 'Maintain current irrigation',
    icon: '→',
    bannerBg: 'bg-blue-50',
    bannerText: 'text-blue-900',
    bannerBorder: 'border-blue-400',
  },
  increase_10: {
    label: 'Increase irrigation +10%',
    icon: '↑',
    bannerBg: 'bg-amber-50',
    bannerText: 'text-amber-900',
    bannerBorder: 'border-amber-400',
  },
  increase_20: {
    label: 'Increase irrigation +20%',
    icon: '↑↑',
    bannerBg: 'bg-orange-50',
    bannerText: 'text-orange-900',
    bannerBorder: 'border-orange-500',
  },
  emergency_irrigate: {
    label: 'EMERGENCY — Irrigate now',
    icon: '⚠',
    bannerBg: 'bg-red-100',
    bannerText: 'text-red-900',
    bannerBorder: 'border-red-600',
  },
};

/** Noise floor used by the stress classifier (µm) */
export const STRESS_NOISE_UM = 30;

/** TGR direction based on noise floor */
export function tgrDirection(tgrUm: number | null): 'up' | 'flat' | 'down' {
  if (tgrUm == null) return 'flat';
  if (tgrUm > STRESS_NOISE_UM) return 'up';
  if (tgrUm < -STRESS_NOISE_UM) return 'down';
  return 'flat';
}
