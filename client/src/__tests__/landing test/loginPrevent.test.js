import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react-dom/test-utils'
import App from '../../App';

test('should not login a  not registered user', () => { 
  const { getByText, getByTestId, getByPlaceholderText, waitFor } = render(<App />);
  const loginButton = getByTestId('login');
  const usernameInput = getByPlaceholderText('Account Name');
  const passwordInput = getByPlaceholderText('Password');
  const alertMock = jest.spyOn(window, 'alert').mockImplementation(() => {});

  act(() => {
  userEvent.type(usernameInput, 'Brad');
  userEvent.type(passwordInput, 'Kulas Light');
  userEvent.click(loginButton);
  });
   expect(localStorage.getItem('username')).toBe(null);
   expect(localStorage.getItem('isLoggedIn')).toBe(null);
   //expect there is a alert message
   expect(alertMock).toHaveBeenCalledTimes(1);
  expect(alertMock).toHaveBeenCalledWith('User Not Registered');

  alertMock.mockRestore();
  
})

test('should not login a empty input, test alert message', () => {
  const { getByText, getByTestId, getByPlaceholderText, waitFor } = render(<App />);
  const loginButton = getByTestId('login');
  const usernameInput = getByPlaceholderText('Account Name');
  const passwordInput = getByPlaceholderText('Password');
  const alertMock = jest.spyOn(window, 'alert').mockImplementation(() => {});

  act(() => {
  userEvent.type(usernameInput, '');
  userEvent.type(passwordInput, '');
  userEvent.click(loginButton);
  });
   expect(localStorage.getItem('username')).toBe(null);
   expect(localStorage.getItem('isLoggedIn')).toBe(null);
   expect(alertMock).toHaveBeenCalledTimes(1);
  expect(alertMock).toHaveBeenCalledWith('Please enter username and password');

  alertMock.mockRestore();
});

test('should not login with wrong password test alert message', () => {
  const { getByText, getByTestId, getByPlaceholderText, waitFor } = render(<App />);
  const loginButton = getByTestId('login');
  const usernameInput = getByPlaceholderText('Account Name');
  const passwordInput = getByPlaceholderText('Password');
  const alertMock = jest.spyOn(window, 'alert').mockImplementation(() => {});

  act(() => {
  userEvent.type(usernameInput, 'Bret');
  userEvent.type(passwordInput, 'wrong password');
  userEvent.click(loginButton);
  });
   expect(localStorage.getItem('username')).toBe(null);
   expect(localStorage.getItem('isLoggedIn')).toBe(null);
   expect(alertMock).toHaveBeenCalledTimes(1);
  expect(alertMock).toHaveBeenCalledWith('Invalid password');

  alertMock.mockRestore();
});