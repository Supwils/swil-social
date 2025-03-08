import React from 'react';
import { render, screen,cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../App';

afterEach(cleanup);

test('adds "active" class to container when register button is clicked', () => {
  const { getByTestId } = render(<App />);
  const registerBtn = getByTestId('registerBtn');
  const container = getByTestId('container');

  userEvent.click(registerBtn);

  expect(container.classList.contains('active')).toBe(true);
});

test('removes "active" class from container when login button is clicked', () => {
  const { getByTestId } = render(<App />);
  const loginBtn = getByTestId('loginSwitch');
  const registerBtn = getByTestId('registerBtn');
  const container = getByTestId('container');

  // First, add the class
  //container.classList.add('active');
  userEvent.click(registerBtn);
  userEvent.click(loginBtn);

  expect(container.classList.contains('active')).toBe(false);
});
