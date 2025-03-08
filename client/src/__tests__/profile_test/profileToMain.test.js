import React from 'react';
import { getByTestId, getByText, render, screen} from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import App from '../../App';
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

test('should go back to main page by click Main Page', () => {
    const { getByText, getByTestId, getByPlaceholderText} = render(<App />);
    const mainBtn = getByText('Main Page');
    
    act(() => {
        userEvent.click(mainBtn);
    });
    expect(localStorage.getItem('isProfile')).toBe('false');
 })