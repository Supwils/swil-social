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
test('should have the user posts to be fetched', () => { 
    const { getByText,getByTestId } = render(<App />);

    const postView = getByTestId('postViewTest');
    expect(postView.textContent).toContain('a quo magni similique perferendis');
    expect(postView.textContent).toContain('est et quae odit qui non');
    

 })