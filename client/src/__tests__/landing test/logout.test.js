import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import App from '../../App';

// Mock the local storage
beforeEach(() => {
    let store = {
        'isLoggedIn': 'true', // Assume user is already logged in
        'username': 'Bret',
        'isProfile': 'false'
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

test('User should be logged out after clicking Log Out', () => {
    const { getByText } = render(<App />);
    
    // Assuming the user is on the main page, click the 'Log Out' button
    const logOutButton = getByText('Log Out');
    fireEvent.click(logOutButton);

    // Check if 'isLoggedIn' is removed from local storage after logging out
    expect(localStorage.removeItem).toHaveBeenCalledWith('isLoggedIn');
    expect(localStorage.getItem('isLoggedIn')).toBe(null);
    expect(localStorage.getItem('username')).toBe(null);
});

