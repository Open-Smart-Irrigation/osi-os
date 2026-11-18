import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useState } from 'react';
import { Modal } from '../../ui-core/Modal';
afterEach(cleanup);
function Nested() {
  const [outer, setOuter] = useState(false), [inner, setInner] = useState(false);
  return <><button onClick={() => setOuter(true)}>Launch</button>
    <Modal title="Outer" isOpen={outer} onClose={() => setOuter(false)}>
      <button onClick={() => setInner(true)}>Next</button>
      <Modal title="Inner" isOpen={inner} onClose={() => setInner(false)}><input aria-label="Name" /></Modal>
    </Modal></>;
}
it('only the topmost dialog traps focus and Escape, then restores each opener', () => {
  render(<Nested />);
  const launch = screen.getByText('Launch'); launch.focus(); fireEvent.click(launch);
  const next = screen.getByText('Next'); next.focus(); fireEvent.click(next);
  expect(screen.getByLabelText('Name')).toHaveFocus();
  launch.focus(); expect(screen.getAllByRole('button', {name: 'Close'})[1]).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, {key: 'Tab', shiftKey: true});
  expect(screen.getByLabelText('Name')).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, {key: 'Escape'});
  expect(screen.queryByRole('dialog', {name: 'Inner'})).not.toBeInTheDocument();
  expect(screen.getByRole('dialog', {name: 'Outer'})).toBeInTheDocument();
  expect(next).toHaveFocus();
  fireEvent.keyDown(next, {key: 'Escape'}); expect(launch).toHaveFocus();
});

it('leaves browser-native in-dialog Tab stops to the browser', () => {
  render(<><button>Launch native stop</button><Modal title="Native stops" isOpen onClose={() => {}}>
    <button>First</button><div contentEditable aria-label="Native browser stop" />
    <details><summary>Compiled week</summary><button>Hidden detail action</button></details>
    <button>Last</button>
  </Modal></>);
  const pane = screen.getByLabelText('Native browser stop');
  pane.focus();
  const event = new KeyboardEvent('keydown', {key: 'Tab', bubbles: true, cancelable: true});
  document.activeElement?.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(pane).toHaveFocus();
  expect(screen.getByText('Compiled week')).toBeVisible();
  expect(screen.getByText('Hidden detail action').closest('details')).not.toHaveAttribute('open');
});
