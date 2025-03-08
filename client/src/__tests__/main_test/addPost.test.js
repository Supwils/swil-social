import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/extend-expect';
import App from '../../App';
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
        const postBtn = getByText('Post');
        const postContent = getByPlaceholderText('Enter post content');
        const postTitle = getByPlaceholderText('Enter post title')
        
        act(() => {
            userEvent.type(postTitle, 'test post');
            userEvent.type(postContent, 'test post content');
            userEvent.click(postBtn);
        });

        const postView = getByTestId('postViewTest');
        expect(postView.textContent).toContain('numquam aut expedita ipsum nulla i');
        
      });
    test('should alert new post without title, title is needed', () => { 
        const { getByText, getByTestId, getByPlaceholderText} = render(<App />);
        const postBtn = getByText('Post');
        const postContent = getByPlaceholderText('Enter post content');
        const postTitle = getByPlaceholderText('Enter post title')
        
        act(() => {
            userEvent.type(postTitle, '');
            userEvent.type(postContent, '');
            userEvent.click(postBtn);
        });

        
        expect(getByText('Title and content cannot be empty!')).toBeInTheDocument();
        
      }); 
 