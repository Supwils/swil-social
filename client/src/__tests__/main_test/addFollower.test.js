import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react';
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
test('should have the user posts to be fetched', () => { 
  const { getByText,getByPlaceholderText,getByTestId } = render(<App />);
  const addUser = getByPlaceholderText('User...');
  const addbtn = getByText('Add');

  act(() => {
    userEvent.type(addUser, 'Kamren');
    userEvent.click(addbtn);
  });
  const postView = getByTestId('postViewTest');
    expect(postView.textContent).toContain('quibusdam cumque rem aut deserunt'); 

 })

 test('should alert the add user not exist', () => { 
  const { getByText,getByPlaceholderText } = render(<App />);
  const addUser = getByPlaceholderText('User...');
  const addbtn = getByText('Add');

  act(() => {
    userEvent.type(addUser, 'Kamrenee');
    userEvent.click(addbtn);
  });
  
expect(getByText('User does not exist or not allowed!')).toBeInTheDocument();
 })


 test('add non exist follower alert message appear only 3 sec', () => { 
  const { getByText,getByPlaceholderText,getByTestId } = render(<App />);
  const addUser = getByPlaceholderText('User...');
  const addbtn = getByText('Add');

  act(() => {
    userEvent.type(addUser, 'Kamrenee');
    userEvent.click(addbtn);
  });
  
  waitFor(() => {
    
    expect(getByText('User does not exist or not allowed!')).not.toBeInTheDocument();
  }, { timeout: 4000 }); 
})