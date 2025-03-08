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
        
        const searchInput = getByPlaceholderText('Search for posts');
        fireEvent.change(searchInput, { target: { value: 'dolorem dolore est ipsam' } });
        
        const searchButton = getByText('Search');
        fireEvent.click(searchButton);
        
        const postView = getByTestId('postViewTest');
        expect(postView.textContent).toContain('dolorem dolore est ipsam');
        expect(postView.textContent).not.toContain('optio molestias id quia eum');
      });
      
test('should return the original set of articles when user dont input anything when click search', () => {
    const { getByText, getByTestId, getByPlaceholderText} = render(<MainPage />);
    const searchInput = getByPlaceholderText('Search for posts');
    const searchButton = getByText('Search');
    fireEvent.change(searchInput, { target: { value: 'dolorem dolore est ipsam' } });
    fireEvent.click(searchButton);
    fireEvent.change(searchInput, { target: { value: '' } });
    fireEvent.click(searchButton);

    const postView = getByTestId('postViewTest');
    expect(postView.textContent).toContain('a quo magni similique perferendis');
    
});

test('should return No posts avaliable when no search result appears', () => {
    const { getByText, getByTestId, getByPlaceholderText} = render(<MainPage />);
    const searchInput = getByPlaceholderText('Search for posts');
    const searchButton = getByText('Search');
    fireEvent.change(searchInput, { target: { value: 'aa' } });
    fireEvent.click(searchButton);


    //const postView = getByTestId('postViewTest');
    expect(getByText('No posts available.')).toBeInTheDocument();
    
});