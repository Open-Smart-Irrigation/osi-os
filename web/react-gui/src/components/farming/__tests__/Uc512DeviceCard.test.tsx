import '@testing-library/jest-dom/vitest';
import {render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import type {Device} from '../../../types/farming';
import {Uc512DeviceCard} from '../Uc512DeviceCard';

vi.mock('../../../services/api', () => ({devicesAPI: {remove: vi.fn()}}));

const controller = {deveui: 'AABBCCDDEEFF0012', name: 'Demo controller', type_id: 'MILESIGHT_UC512',
  latest_data: {bat_pct: 90, valve_1_state: 'open', valve_2_state: 'close'}} as unknown as Device;

describe('Uc512DeviceCard', () => {
  it('shows both independently reported native channel states', () => {
    render(<Uc512DeviceCard device={controller} removeContext="farm" />);

    expect(screen.getByText('Valve 1 state')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Valve 2 state')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByText('Reported state')).not.toBeInTheDocument();
  });

  it('keeps missing channel state distinct from a reported closed state', () => {
    render(<Uc512DeviceCard device={{...controller, latest_data: {bat_pct: 90, valve_1_state: null,
      valve_2_state: 'close'}} as unknown as Device} removeContext="farm" />);

    expect(screen.getAllByText('Unavailable')).toHaveLength(1);
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });
});
