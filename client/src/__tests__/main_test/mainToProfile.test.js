import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../../App';
import MainPage from '../../Main/Main';
import { act } from 'react-dom/test-utils';
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

test('should fetch subset of articles for a logged-in user to search posts', () => { 
        const { getByText, getByTestId, getByPlaceholderText} = render(<App />);
        const profileBtn = getByText('Profile');
        
        act(() => {
            userEvent.click(profileBtn);
        });

        const profileTest = getByTestId('profileTest');
        expect(profileTest.textContent).toContain('Sincere@april.biz');
        
      });
      
 