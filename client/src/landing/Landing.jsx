import React, {useState, useEffect} from "react";
import { ReactDOM } from "react";
import '../style.css'
import './landing.css'
import logo from '../logoAI.jpeg';
import MainPage from "../Main/Main.jsx";
import RegistrationForm from "./Registration";
import LogIn from "./LogIn";
import { useLocation } from 'react-router-dom';

function Landing({isLoggedIn, setIsLoggedIn}) {
    const location = useLocation();

    
    useEffect(() => {
        const queryParams = new URLSearchParams(location.search);
        const username = queryParams.get('username');
        const isLoggedIn = queryParams.get('isLoggedIn') === 'true';

        if (isLoggedIn && username) {
            localStorage.setItem('username', username);
            localStorage.setItem('isLoggedIn', 'true');
            setIsLoggedIn(true);
            // Proceed with logged-in user flow
        }
        const container = document.getElementById('container');
        const registerBtn = document.getElementById('register');
        const loginBtn = document.getElementById('login');

        if (registerBtn && loginBtn && container) {
            registerBtn.addEventListener('click', () => {
                container.classList.add("active");
            });

            loginBtn.addEventListener('click', () => {
                container.classList.remove("active");
            });
        }

        // Cleanup - remove event listeners when component is unmounted
        return () => {
            if (registerBtn && loginBtn) {
                registerBtn.removeEventListener('click', () => container.classList.add("active"));
                loginBtn.removeEventListener('click', () => container.classList.remove("active"));
            }
        };
    }, [location]);

        const handleFromSubmit = (event) => {
            //return;
            setIsLoggedIn(true);
        } 
        
    return (
        <div className="landingPageContainer">
        <div className="container" id="container" data-testid="container">
            <RegistrationForm isLoggedIn={isLoggedIn} setIsLoggedIn={setIsLoggedIn} onFormSubmit={handleFromSubmit}/>
            <LogIn isLoggedIn={isLoggedIn} setIsLoggedIn={setIsLoggedIn} />
            <div className="toggle-container">

            <div className="toggle">
                <div className="toggle-panel toggle-left">
                    <h1>Welcome Back!</h1>
                    <button className="hidden" id="login" data-testid = 'loginSwitch'>Log In</button>
                </div>
                <div className="toggle-panel toggle-right">
                    <h1>Hello, Friend!</h1>
                    <button className="hidden" id="register" data-testid="registerBtn">Sign Up</button>
                </div>
            </div>
        </div>
        </div>
        </div>
    
    );
    }
export default Landing;


