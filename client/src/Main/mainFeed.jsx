import React, {useState, useEffect} from "react";
import * as getInfo from "../profile/getInfo.js";
import userData from "../users.json";
import axios from "axios";
import * as getinfodb from "../profile/getInfoMongo.js";
import {baseUrl} from "../backend.js";




const MainHeadlines = ({follower,setfollower,onUserRemove, onUserAdd}) => {
    const [usersToDisplay, setUsersToDisplay] = useState([]);
    const [inputText, setInputText] = useState('');
    const [errorMessage, setErrorMessage] = useState('');
  
    useEffect(() => {
      getinfodb.getUserFollowing().then((followingUsers) => {setUsersToDisplay(followingUsers)});
    }, []);

  
    const handleRemoveUser = (username) => {
      try{
        const response = axios.delete(baseUrl + "following/"+username, {withCredentials: true})
        if (response.status === 200) {
            setUsersToDisplay(prevUsers => prevUsers.filter(user => user.username !== username));
            //onUserRemove(username);
          }
          window.location.reload();
        }
        catch (error) {
          alert('Unfollow failed: ' + error.message);
        }
        

        //onUserRemove(username);
      };






    const handleAddUser = async() => {
      const addUser = inputText;
      const response = await axios.put(baseUrl + "following/"+addUser,{}, {withCredentials: true})
      if (response.status === 200) {
          setUsersToDisplay(prevUsers => [...prevUsers, addUser]);
          setInputText('');
          window.location.reload();
          
        }

      else if (response.status === 400) {
          setErrorMessage("Can't follow yourself!");
          setInputText(''); // clear the input

          setTimeout(() => {
            setErrorMessage('');
        }, 3000);
        }
      else if (response.status === 404) {
          setErrorMessage("User not found!");
          setInputText(''); // clear the input

          setTimeout(() => {
            setErrorMessage('');
        }, 3000);
        }
        else if (response.status === 409){
          setErrorMessage("Already following this user!");
          setInputText(''); // clear the input

          setTimeout(() => {
            setErrorMessage('');
        }, 3000);
        }
      };
      




    return (
        <div>
      <div className="followHeadline">
        <h2>Following</h2>
        {usersToDisplay.map(user => (
          <div key={user.username} style={{ marginBottom: '20px' }}>
            <img className={"headlinesImage"}src={user.avatar} alt="Avatar" />
            <h3>{user.username}</h3>
            <p>{user.headline}</p>
            <button className="dynamicButton" onClick={() => handleRemoveUser(user.username)} >Remove</button>
          </div>
        ))}
        </div>
        <input
        type="text"
        placeholder="User..."
        value={inputText}
        onChange={e => setInputText(e.target.value)}
      />
      <button className="dynamicButton" onClick={handleAddUser}>Add</button>
      {errorMessage && <span style={{ color: 'red' }}>{errorMessage}</span>}
      </div>
    );
  };
export default MainHeadlines;