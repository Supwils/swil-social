import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react-dom/test-utils'
import App from '../../App';

test('should alert when register new user that password not match', () => {
    const { getByText, getByTestId, getByPlaceholderText } = render(<App />);

    const signupButton = getByText('Sign Up');
    const loginButton = getByTestId('loginSwitch');
    const submit = getByTestId('regsubmit');
    const usernameInput = getByPlaceholderText('Account Name');
    const fullNameInput = getByPlaceholderText('Full Name');
    const emailInput = getByPlaceholderText('Email Address');
    const phoneInput = getByPlaceholderText('Phone Number');
    const dob = getByTestId('dob');
    const passwordInput = getByPlaceholderText('New Password');
    const confirmPasswordInput = getByPlaceholderText('Comfirm New Password');
    const alertMock = jest.spyOn(window, 'alert').mockImplementation(() => {});

    act(() => {
        userEvent.click(signupButton);
        userEvent.click(loginButton);
        userEvent.click(signupButton);
        userEvent.type(usernameInput, 'Supwils');
        userEvent.type(fullNameInput, 'Huahao Shang');
        userEvent.type(emailInput, 'hushang@syr.edu');
        userEvent.type(phoneInput, '315-123-4567');
        userEvent.type(dob, '1999-01-01');
        userEvent.type(passwordInput, '1234567');
        userEvent.type(confirmPasswordInput, '123456');
        userEvent.click(submit);
    });
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock).toBeCalledWith('Passwords do not match!');
    alertMock.mockRestore();
    
});

test('should alert registered user must at least 18 years old', () => {
    const { getByText, getByTestId, getByPlaceholderText } = render(<App />);

    const signupButton = getByText('Sign Up');
    const loginButton = getByTestId('loginSwitch');
    const submit = getByTestId('regsubmit');
    const usernameInput = getByPlaceholderText('Account Name');
    const fullNameInput = getByPlaceholderText('Full Name');
    const emailInput = getByPlaceholderText('Email Address');
    const phoneInput = getByPlaceholderText('Phone Number');
    const dob = getByTestId('dob');
    const passwordInput = getByPlaceholderText('New Password');
    const confirmPasswordInput = getByPlaceholderText('Comfirm New Password');
    const alertMock = jest.spyOn(window, 'alert').mockImplementation(() => {});

    act(() => {
        userEvent.click(signupButton);
        userEvent.click(loginButton);
        userEvent.click(signupButton);
        userEvent.type(usernameInput, 'Supwils');
        userEvent.type(fullNameInput, 'Huahao Shang');
        userEvent.type(emailInput, 'hushang@syr.edu');
        userEvent.type(phoneInput, '315-123-4567');
        userEvent.type(dob, '2010-01-01');
        userEvent.type(passwordInput, '123456');
        userEvent.type(confirmPasswordInput, '123456');
        userEvent.click(submit);
    });
    expect(alertMock).toHaveBeenCalledTimes(1);
    expect(alertMock).toBeCalledWith('You must be at least 18 years old to register!');
    alertMock.mockRestore();
    
});
