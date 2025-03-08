import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import App from '../../App';
import MainPage from '../../Main/Main';
import '@testing-library/jest-dom/extend-expect';
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
        const { getByText, getByTestId, getByPlaceholderText} = render(<MainPage />);
        
        const left = getByTestId('left');
        const right = getByTestId('right');
        fireEvent.click(left);
        fireEvent.click(right);
        fireEvent.click(right);
        fireEvent.click(left);
        const postView = getByTestId('postViewTest');
        expect(postView.textContent).toContain('delectus ullam et corporis nulla voluptas');
      });

test('should hide or show post comments', () => { 
        const { getByText, getByTestId, getByPlaceholderText} = render(<MainPage />);
        
        const commentBtn = getByTestId('37');
        fireEvent.click(commentBtn);
        const postView = getByTestId('postViewTest');
        expect(postView.textContent).not.toContain('comment for the 37 post');
      });