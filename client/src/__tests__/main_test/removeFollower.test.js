
import React from 'react';
import { render, fireEvent,within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
test('should have the user posts to be fetched', () => { 
  const { getByText,getByPlaceholderText,getByTestId } = render(<App />);
  const userName = getByText('Clementine Bauch'); // Replace with actual user name
    const userContainer = userName.closest('div'); // Assuming the name is directly inside the div
    const removeButton = within(userContainer).getByText('Remove');

  act(() => {
    userEvent.click(removeButton);
  });
  const postView = getByTestId('postViewTest');
    expect(postView.textContent).not.toContain('a quo magni similique perferendis');
    

 })