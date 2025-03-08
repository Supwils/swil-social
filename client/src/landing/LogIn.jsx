import React, {useState, useEffect} from "react";
import users from "../users.json";
import logo from '../logoAI.jpeg';
import axios from 'axios';
import {baseUrl} from "../backend.js";
function LogIn({ isLoggedIn, setIsLoggedIn }) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');

    const handleLogin = async (event) => {
        event.preventDefault(); // Prevent default form submission behavior

        if (username === '' || password === '') {
            alert('Please enter username and password');
            return;
        }

        try {
            // Make a POST request to the backend login endpoint
            const response = await axios.post(baseUrl+'login', { username, password }, { withCredentials: true });
            
            if (response.data.result === 'success') {
                setIsLoggedIn(true);
                localStorage.setItem('isLoggedIn', 'true');
                localStorage.setItem('username', username);

            } else {
                alert('Login failed');
            }
        } catch (error) {
            alert('Login failed: ' + error.message);
        }
    };

    if (isLoggedIn) {
        return null;
    }


    return (
        <div className="form-container sign-in">
            <form data-testid="login-form" onSubmit={handleLogin}>
            <img className="loginLogo" src={logo} alt="Logo" />
            <a href={baseUrl + "auth/google"}>Login with Google</a>
                <h1>Sign In</h1>
                <input 
                    type="text" 
                    placeholder="Account Name" 
                    value={username} 
                    onChange={e => setUsername(e.target.value)}
                />
                <input 
                    type="password" 
                    placeholder="Password" 
                    value={password} 
                    onChange={e => setPassword(e.target.value)}
        />
                <a href="#">Forget Your Password?</a>
                <button type="submit" data-testid="login" >Log In</button>
            </form>
        </div>
    );
}

export default LogIn; 
