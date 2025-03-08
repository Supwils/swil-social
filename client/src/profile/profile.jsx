import React, { useEffect, useState } from "react";
import * as getinfo from "./getInfo.js";
import * as getinfodb from "./getInfoMongo.js";
import "./profile.css";
import ImageUploadComponent from "./profileImgChange.jsx";
import axios from "axios";
import {baseUrl} from "../backend.js";
const baseURL = baseUrl

function Profile({ onMain, onLogout }) {
  const [userPicture , setUserPicture] = useState('');
  const [userName, setUserName] = useState(localStorage.getItem('username'));
  const [userEmail, setUserEmail] = useState('');
  const [userPhone, setUserPhone] = useState('');
  const [userZip, setUserZip] = useState('');
  const [userPassword, setUserPassword] = useState('');
  const [alertPassword, setAlertPassword] = useState("");

  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newZip, setNewZip] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    getinfodb.getUserEmail().then(email => setUserEmail(email));
    getinfodb.getUserPhone().then(phone => setUserPhone(phone));
    getinfodb.getUserZipcode().then(zipcode => setUserZip(zipcode));
    getinfodb.getUserPassword().then(password => setUserPassword(password));
    getinfodb.getUserAvatar().then(avatar => setUserPicture(avatar));
  }, []);

const updateProfile = async (e) => {
  try{
    if (newEmail !== '') 
    {
    const response = await axios.put(baseURL+'email', {email: newEmail}, {withCredentials: true});
    if (response.status === 200) {
      setUserEmail(newEmail);
    }
    else {
      alert('Email Update failed');
    }
  }
  if (newPhone !== '') 
    {
    const response2 = await axios.put(baseURL+'phone', {phone: newPhone}, {withCredentials: true});
    if (response2.status === 200) {
      setUserPhone(newPhone);
    }
    else {
      alert('Phone Update failed');
    }
  }
  if (newZip !== ''){
    const response3 = await axios.put(baseURL+'zipcode', {zipcode: newZip}, {withCredentials: true});
    if (response3.status === 200) {
      setUserZip(newZip);
    }
    else {
      alert('Zip Update failed');
    }
  }
  }
  catch (error) {
    alert('Update failed: ' + error.message);
  }
}

  const handleProfileUpdate = (e) => {
    e.preventDefault();
    setAlertPassword("");

    if (newPassword !== confirmPassword) {
      setAlertPassword("Passwords do not match!");
      return;
    }

    if (newName) setUserName(newName);
    updateProfile();
    if (newPassword) {
      setUserPassword(newPassword);
      
    }

    
    setNewName('');
    setNewEmail('');
    setNewPhone('');
    setNewZip('');
    setNewPassword('');
    setConfirmPassword('');
    setAlertPassword("");
  };

  return (
    <div className="theProfile" data-testid='profileTest'>
      <nav className="profileNav">
      <button className="dynamicButton backMainButton" onClick={onMain}>Main Page</button>
      <button className="dynamicButton backMainButton" onClick={onLogout}>Logout</button>
      </nav>
      <h1>{userName} Profile Page</h1>
      <h2>Welcome to the Profile Page</h2>

      <div className="profilePictureComponent">
        <img className="profileImg" src={userPicture} alt="Profile Picture" />
        <ImageUploadComponent />
      </div>

      <div className="profileContainer">
        <div className="currentInfo" data-testid="personalInfo">
          <h2>Personal Info</h2>
          <h3>{userName}</h3>
          <h3>{userEmail}</h3>
          <h3>{userPhone}</h3>
          <h3>{userZip}</h3>
          {/* <h3>{userPassword.replace(/./g, '*')}</h3> */}
        </div>
        <div className="updateInfo">
          <h2>New Info</h2>
          <form className="updateForm" onSubmit={handleProfileUpdate}>
            <input type="text" placeholder="New Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <input type="email" placeholder="New Email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            <input type="text" placeholder="New Phone Number" pattern="\d{3}-\d{3}-\d{4}" title="Format: XXX-XXX-XXXX" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
            <input type="text" placeholder="Zip" pattern="\d{5}" title="Please enter 5 digit zip" value={newZip} onChange={(e) => setNewZip(e.target.value)} />
            <input type="password" placeholder="Password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            <input type="password" placeholder="Confirm Password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            {alertPassword && <span style={{ color: "red" }}>{alertPassword}</span>}
            <button className="dynamicButton" data-testid="update" type="submit">Update</button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default Profile;
