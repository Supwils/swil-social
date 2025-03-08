import React from 'react';
import { render, fireEvent,screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/extend-expect';
import App from '../../App';
import Main from '../../Main/Main'
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
test('should have the user headline able to change', () => { 
    const { getByText,getByTestId,getByPlaceholderText } = render(<Main />);
    // to have the user posts to be fetched and local storge userPosts is not null
    const newHeadline = getByPlaceholderText('New Headline');
    const headlineBtn = getByText('Update');

    act(() => {
    userEvent.type(newHeadline, 'No pain');
    userEvent.click(headlineBtn);
    });

    expect(getByText('No pain')).toBeInTheDocument();
    

 })
 test('should have the user headline not change if just click', () => { 
    const { getByText,getByTestId,getByPlaceholderText } = render(<Main />);
    // to have the user posts to be fetched and local storge userPosts is not null
    const newHeadline = getByPlaceholderText('New Headline');
    const headlineBtn = getByText('Update');

    act(() => {
    userEvent.type(newHeadline, '');
    userEvent.click(headlineBtn);
    });

    expect(getByText('Please enter a valid headline!')).toBeInTheDocument();
    

 })