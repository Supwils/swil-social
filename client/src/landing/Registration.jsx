import React, { useState } from 'react';
import axios from 'axios';
import {baseUrl} from "../backend.js";



function RegistrationForm({onFormSubmit, isLoggedIn, setIsLoggedIn}) {
    const [formData, setFormData] = useState({
        accountName: "",
        displayName: "",
        email: "",
        phoneNumber: "",
        dateOfBirth: "",
        zipCode: "",
        password: "",
        confirmPassword: ""
    });

    const handleInputChange = (event) => {
        const { name, value } = event.target;
        setFormData(prevData => ({ ...prevData, [name]: value }));
    }

    const handleSubmit = async (event) => {
        event.preventDefault(); 

        // Age check
        const age = calcAge(formData.dateOfBirth);
        if (age < 18) {
            alert('You must be at least 18 years old to register!');
            return;
        }

        // Password matching check
        if (formData.password !== formData.confirmPassword) {
            alert('Passwords do not match!');
            return;
        }

        const timestamp = new Date().getTime();
        //console.log("Form submitted with timestamp:", timestamp);
        try{
            const response = await axios.post(baseUrl+'register',
            {
                username: formData.accountName,
                password: formData.password,
                email: formData.email,
                dob: formData.dateOfBirth,
                zipcode: formData.zipCode,
                phone: formData.phoneNumber
            }, { withCredentials: true });
        }
        catch (error) {
            alert('Registration failed: ' + error.message);
        }
        setIsLoggedIn(true);
        localStorage.setItem('username', formData.accountName);
        localStorage.setItem('isLoggedIn', true);
        //alert('Registration successful!');
        onFormSubmit();
        // Here, you'd typically send the formData to your server, e.g., with a fetch() call.
    }
    const handleReset = (event) => {
        event.preventDefault();
        setFormData({
            accountName: "",
            displayName: "",
            email: "",
            phoneNumber: "",
            dateOfBirth: "",
            zipCode: "",
            password: "",
            confirmPassword: ""
        }); 
    }

    const calcAge = (dob) => {
        const date = new Date(dob);
        const today = new Date();
        const timeDiff = Math.abs(today.getTime() - date.getTime());
        return Math.ceil(timeDiff / (1000 * 3600 * 24)) / 365;
    }
    if (isLoggedIn) {
        return null;
    }

    return (
        <div className="form-container sign-up form" style={{ textAlign: 'center' }}>
            
            <form onSubmit={handleSubmit}>
            <h1 >User Registration</h1>
            <br />
                
                
                    <input placeholder='User Name' type="text" name="accountName" value={formData.accountName} onChange={handleInputChange} required pattern="[A-Za-z][A-Za-z0-9]*" />
                <br />

                
                    <input placeholder='Full Name' type="text" name="displayName" value={formData.displayName} onChange={handleInputChange} required />
                <br />

              
                    <input placeholder='Email Address' type="email" name="email" value={formData.email} onChange={handleInputChange} required />
                <br/>

                    <input placeholder='Phone Number' type="tel" name="phoneNumber" value={formData.phoneNumber} onChange={handleInputChange} required pattern="\d{3}-\d{3}-\d{4}" title="Format: XXX-XXXX-XXX" />
                <br />

                <label>
                    Date of Birth:
                    <input data-testid='dob' type="date" name="dateOfBirth" value={formData.dateOfBirth} onChange={handleInputChange} required />
                </label>
                <br />

                
                    <input placeholder='Zip' type="text" name="zipCode" value={formData.zipCode} onChange={handleInputChange} required pattern="\d{5}" title="5 digit zip please!"/>
            
                <br />

                
                    <input placeholder='New Password' type="password" name="password" value={formData.password} onChange={handleInputChange} required />
                
                <br />

                
                    <input placeholder='Comfirm New Password' type="password" name="confirmPassword" value={formData.confirmPassword} onChange={handleInputChange} required />
                
                <br />

                
                

                <button type="reset" onClick={handleReset} className="dynamicButton" value="Reset">Reset</button>
                <button data-testid='regsubmit' type="submit" value="Submit" className="dynamicButton">Submit</button>
            </form>
        </div>
    );
}

export default RegistrationForm;
