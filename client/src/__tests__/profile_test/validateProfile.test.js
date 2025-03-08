import React from 'react';
import { getByTestId, getByText, render, screen} from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import Profile from '../../profile/profile';
import userEvent from '@testing-library/user-event';
import { act } from 'react-dom/test-utils';

// Mock the local storage
beforeEach(() => {
    let store = {
        'isLoggedIn': 'true', // Assume user is already logged in
        'username': 'Bret',
        'isProfile': 'true'
    };
    Object.defineProperty(window, 'localStorage', {
        value: {
            getItem: jest.fn((key) => store[key] || null),
            setItem: jest.fn((key, value) => store[key] = value.toString()),
            removeItem: jest.fn((key) => delete store[key]),
        },
        writable: true
    });
});

test('should have user profile name fetched', () => { 
    render(<Profile />);
    
    expect(localStorage.getItem('username')).toBe('Bret');

    expect(screen.getByText('Leanne Graham')).toBeInTheDocument();
 })

 test('should test the profile update by partial updates', () => {
    const { getByText, getByTestId, getByPlaceholderText} = render(<Profile />);
    const updateButton = getByText('Update');
    const newName = getByPlaceholderText('New Name');
    const newEmail = getByPlaceholderText('New Email');
    const newPhone = getByPlaceholderText('New Phone Number');

    act(() => {
        userEvent.type(newName, 'Superman');
        userEvent.type(newEmail, 'superman@rice.edu');
        userEvent.click(updateButton);
    });
    expect(getByText('Superman')).toBeInTheDocument();
    expect(getByText('superman@rice.edu')).toBeInTheDocument();
 });

 test('should test the profile update when password not match', () => {
    const { getByText, getByTestId, getByPlaceholderText} = render(<Profile />);
    const updateButton = getByText('Update');
    const newName = getByPlaceholderText('New Name');
    const newEmail = getByPlaceholderText('New Email');
    const password = getByPlaceholderText('Password');
    const confirmPassword = getByPlaceholderText('Confirm Password');

    act(() => {
        userEvent.type(newName, 'Superman');
        userEvent.type(newEmail, 'superman@rice.edu');
        userEvent.type(password, '123456');
        userEvent.type(confirmPassword, '1234567');
        userEvent.click(updateButton);
    });

    expect(getByText('Passwords do not match!')).toBeInTheDocument();
 });

 test('should test the profile update with full updates', () => {
    const { getByText, getByTestId, getByPlaceholderText} = render(<Profile />);
    const updateButton = getByText('Update');
    const newName = getByPlaceholderText('New Name');
    const newEmail = getByPlaceholderText('New Email');
    const newPhone = getByPlaceholderText('New Phone Number');
    const Zipcode = getByPlaceholderText('Zip');
    const password = getByPlaceholderText('Password');
    const confirmPassword = getByPlaceholderText('Confirm Password');

    act(() => {
        userEvent.type(newName, 'Superman');
        userEvent.type(newEmail, 'superman@rice.edu');
        userEvent.type(newPhone, '315-480-3306');
        userEvent.type(Zipcode, '77005');
        userEvent.type(password, 'abc123');
        userEvent.type(confirmPassword, 'abc123');
        userEvent.click(updateButton);
    });

    expect(getByText('Superman')).toBeInTheDocument();
    expect(getByText('77005')).toBeInTheDocument();
    expect(getByText('******')).toBeInTheDocument();
    expect(getByText('superman@rice.edu')).toBeInTheDocument();
 });

 

 