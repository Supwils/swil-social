import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react-dom/test-utils'
import App from '../../App';

test('should login a registered user', () => { 
  const { getByText, getByTestId, getByPlaceholderText, waitFor } = render(<App />);
  const loginButton = getByTestId('login');
  const usernameInput = getByPlaceholderText('Account Name');
  const passwordInput = getByPlaceholderText('Password');
 
  act(() => {
  userEvent.type(usernameInput, 'Bret');
  userEvent.type(passwordInput, 'Kulas Light');
  userEvent.click(loginButton);
  });
   expect(localStorage.getItem('username')).toBe('Bret');
   expect(localStorage.getItem('isLoggedIn')).toBe('true');
})
//clear local storage
// afterEach(() => {
//   localStorage.clear();
// });
// test('should login a registered user', () => { 
//   const { getByText, getByTestId, getByPlaceholderText, waitFor } = render(<App />);
//   const loginButton = getByTestId('login');
//   const usernameInput = getByPlaceholderText('Account Name');
//   const passwordInput = getByPlaceholderText('Password');
 
//   act(() => {
//   userEvent.type(usernameInput, 'Samantha');
//   userEvent.type(passwordInput, 'Douglas Extension');
//   userEvent.click(loginButton);
//   });
//    expect(localStorage.getItem('username')).toBe('Samantha');
//    expect(localStorage.getItem('isLoggedIn')).toBe('true');
// })