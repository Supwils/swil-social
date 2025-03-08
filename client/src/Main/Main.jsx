import React, { useState, useRef, useEffect } from "react";
import * as getinfodb from "../profile/getInfoMongo.js";
import * as getinfo from "../profile/getInfo.js";
import axios from "axios";
import "./mainstyle.css";
import PostImgPreview from "./ImageReader.jsx";
import PostsViewer from "./postViewer.jsx";
import MainHeadlines from "./mainFeed.jsx";
import logo from './logoAI.jpeg';
import postsData from '../posts.json';
import users from '../users.json';
import { useLocation } from 'react-router-dom';

import { baseUrl } from "../backend.js";


function convertDateFormat(dateString)
{
    const date = new Date(dateString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
function setInitFollowers()
{
    //based on the user's id, get the posts associate with this id and also next 3 ids posts
    const userKey = localStorage.getItem('username');
    const userID = users.find(item => item['username'] === userKey)?.id;
    //if nextID is 11 then set it to 1
    const nextID = userID + 1 > 10 ? (userID + 1) % 10 : userID + 1;
    const nextID2 = userID + 2 > 10 ? (userID + 2) % 10 : userID + 2;
    const nextID3 = userID + 3 > 10 ? (userID + 3) % 10 : userID + 3;
    const defFollower = [nextID, nextID2, nextID3]
    return defFollower;
}
function getPosts(follower)
{
    const posts = [];
    const userKey = localStorage.getItem('username');
    const userID = users.find(item => item['username'] === userKey)?.id;
    posts.push(postsData.filter(item => item['userId'] === userID));
    for (const ids in follower)
    {
        posts.push(postsData.filter(item => item['userId'] === follower[ids]));
    }
    const flatArray = posts.reduce((accumulator, currentArray) =>
    {
        return accumulator.concat(currentArray);
    }, []);
    return flatArray;
}
function MainPage({ onLogout, onProfile })
{

    const userKey = localStorage.getItem('username');
    //const [headline, setHeadline] = useState(localStorage.getItem('headline') || getinfo.getUserHeadline());
    const [headline, setHeadline] = useState('');
    const [alertMsgHeadline, setAlertMsgHeadline] = useState("");
    const [alertMsgPost, setAlertMsgPost] = useState("");
    const headlineRef = useRef();
    const [follower, setfollower] = useState(setInitFollowers());
    const userName = userKey;
    const [userPicture, setUserPicture] = useState('');
    const userID = 0//users.find(item => item['username'] === userKey)['id'];
    const [userPosts, setUserPosts] = useState([]);
    const [postsDB, setPostsDB] = useState([]);
    const [searchQuery, setSearchQuery] = useState("");
    const [imagePreview, setImagePreview] = useState("#");
    const [selectedImage, setSelectedImage] = useState(null);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [showPostModal, setShowPostModal] = useState(false);

    const location = useLocation();

    useEffect(() =>
    {

        const queryParams = new URLSearchParams(location.search);
        const username = queryParams.get('username');
        const isLoggedIn = queryParams.get('isLoggedIn') === 'true';

        if (isLoggedIn && username)
        {
            localStorage.setItem('username', username);
            localStorage.setItem('isLoggedIn', 'true');
            // Proceed with logged-in user flow
        }


        getinfodb.getUserHeadline().then(headline => setHeadline(headline));
        getinfodb.getUserArticles().then(articles => setUserPosts(articles));
        getinfodb.getUserAvatar().then(avatar => setUserPicture(avatar));
    }, [location])





    const handleHeadlineUpdate = async () =>
    {
        const newHeadline = headlineRef.current.value.trim();
        if (!newHeadline)
        {
            setAlertMsgHeadline("Please enter a valid headline!");
            setTimeout(() => setAlertMsgHeadline(""), 3000);
            return;
        }
        try
        {
            const response = await axios.put(baseUrl + 'headline', { headline: newHeadline }, { withCredentials: true });
            if (response.status === 200)
            {
                setHeadline(newHeadline);
                window.location.reload();
            }
            else
            {
                alert('Headline Update failed');
            }
        }
        catch (error)
        {
            alert('Update failed: ' + error.message);
        }
        setTimeout(() => setAlertMsgHeadline(""), 3000);
    };





    const handleUserRemove = (userId) =>
    {
        // Remove the user from the follower state
        const updatedFollower = follower.filter(id => id !== userId);

        // Update the follower state
        setfollower(updatedFollower);

        // Remove the user posts from the userPosts state
        const updatedUserPosts = userPosts.filter(post => post.userId !== userId);
        setUserPosts(updatedUserPosts);
    }





    const handleUserAdd = (userId) =>
    {
        // const updatedFollower = [...follower, userId];
        // setfollower(updatedFollower);

        // const updatedUserPosts = [...userPosts, ...postsData.filter(post => post.userId === userId)];
        // setUserPosts(updatedUserPosts);

    }





    const handleNewPost = async (title, content) =>
    {
        if (!content.trim())
        {
            setAlertMsgPost("Title and content cannot be empty!");
            return;
        }
        try
        {
            const formData = new FormData();
            formData.append('text', content);
            if (selectedImage)
            {
                if (!selectedImage.type.startsWith('image/'))
                {
                    alert('Please select an image file');
                    return;
                }
                if (selectedImage.size > 5000000)
                { // 5MB size limit example
                    alert('File size should be less than 5MB');
                    return;
                }
                formData.append('image', selectedImage);

            }
            const response = await axios.post(baseUrl + 'articles', formData, { withCredentials: true });
            if (response.status === 200)
            {
                const response2 = await axios.get(baseUrl + 'articless', { withCredentials: true });
                const newPost = response2.data.articles[0];
                const updatedUserPosts = [newPost, ...userPosts];
                setUserPosts(updatedUserPosts);
                setAlertMsgPost("");
            }
            window.location.reload();
        }
        catch (error)
        {
            alert('Post failed: ' + error.message);
        }

    };







    const handleSearch = () =>
    {

        if (!searchQuery.trim())
        {
            // Set the posts back to original if search query is empty
            window.location.reload();
            return;
        }

        const filteredPosts = userPosts.filter(post =>
            post.text.toLowerCase().includes(searchQuery.toLowerCase())
        );

        setUserPosts(filteredPosts);
    };

    const handleImageChange = (e) =>
    {
        const file = e.target.files[0];
        if (file)
        {
            const reader = new FileReader();
            reader.onloadend = () =>
            {
                setImagePreview(reader.result);
            };
            reader.readAsDataURL(file);
            setSelectedImage(file);
        }
    }

    const openPostModal = () =>
    {
        setShowPostModal(true);
        setTitle('');
        setContent('');
        setImagePreview('#');
        setSelectedImage(null);
    };

    const closePostModal = () =>
    {
        setShowPostModal(false);
    };

    const handleFormSubmit = (e) =>
    {
        e.preventDefault();
        handleNewPost(title, content);
        setTitle('');
        setContent('');
        setImagePreview('#');
        setSelectedImage(null);
        setShowPostModal(false);
    };

    return (
        <div className="mainPage">


            <nav className="mainNav">
                <button className="dynamicButton mainButton" onClick={onLogout}>Log Out</button>
                <button className="dynamicButton mainButton" onClick={onProfile}>Profile</button>
            </nav>

            <div className="mainContent">
                <div className="mainTop">

                    <div className="mainNavandProfile">


                        <div>
                            <img className="profileImg" src={userPicture} alt="Profile Picture" />
                        </div>

                        <h3> {userName}</h3>
                        <p> {headline} </p>
                        <input type="text" ref={headlineRef} id="updateHeadline" placeholder="New Headline" />
                        <button className="dynamicButton" type="submit" onClick={handleHeadlineUpdate}>Update</button>
                        {alertMsgHeadline && <span style={{ color: "red" }}>{alertMsgHeadline}</span>}

                    </div>

                    <div className="mainNewPost">

                        <div className="post-creation-area">
                            <button className="create-post-button" onClick={openPostModal}>
                                <i className="bx bx-plus"></i> Create New Post
                            </button>
                        </div>

                        {/* Post Creation Modal */}
                        {showPostModal && (
                            <div className="post-modal-overlay" onClick={closePostModal}>
                                <div className="post-modal-content" onClick={(e) => e.stopPropagation()}>
                                    <div className="post-modal-header">
                                        <h3>Create a New Post</h3>
                                        <button className="post-modal-close" onClick={closePostModal}>×</button>
                                    </div>

                                    <form
                                        className="post-modal-form"
                                        onSubmit={handleFormSubmit}
                                        encType="multipart/form-data"
                                    >
                                        <div className="post-create-container">
                                            <div className="post-image-preview">
                                                {imagePreview && imagePreview !== '#' ? (
                                                    <img
                                                        id="previewImage"
                                                        src={imagePreview}
                                                        alt="Preview"
                                                        onClick={() => document.getElementById('fileInput').click()}
                                                    />
                                                ) : (
                                                    <div
                                                        className="image-upload-placeholder"
                                                        onClick={() => document.getElementById('fileInput').click()}
                                                    >
                                                        <span>Click to add an image</span>
                                                    </div>
                                                )}
                                                <input
                                                    type="file"
                                                    id="fileInput"
                                                    onChange={handleImageChange}
                                                    style={{ display: 'none' }}
                                                    accept="image/*"
                                                />
                                            </div>

                                            <div className="post-title-input">
                                                <input
                                                    type="text"
                                                    data-testid="postTitle"
                                                    name="postTitle"
                                                    id="postTitle"
                                                    placeholder="Enter post title"
                                                    value={title}
                                                    onChange={(e) => setTitle(e.target.value)}
                                                />
                                            </div>

                                            <div className="post-content-input">
                                                <textarea
                                                    data-testid="postContent"
                                                    name="postContent"
                                                    id="postContent"
                                                    placeholder="Enter post content"
                                                    value={content}
                                                    onChange={(e) => setContent(e.target.value)}
                                                ></textarea>
                                            </div>
                                        </div>

                                        <div className="post-modal-actions">
                                            <button className="dynamicButton" type="submit" data-testid="postButton">Post</button>
                                            <button className="dynamicButton cancel-button" type="button" onClick={closePostModal}>Cancel</button>
                                            {alertMsgPost && <span className="alert-message">{alertMsgPost}</span>}
                                        </div>
                                    </form>
                                </div>
                            </div>
                        )}

                    </div>

                    <div className="logoImage">
                        <img className="logoImage" src={logo} alt="Logo" />
                    </div>

                </div>

                <div className="mainBottom">

                    <MainHeadlines follower={follower} setfollower={setfollower} onUserRemove={handleUserRemove} onUserAdd={handleUserAdd} />

                    <div className="mainPosts">

                        <div className="searchBar">
                            <input type="text" id="searchBar" placeholder="Search for posts"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)} />
                            <button className="dynamicButton" type="submit" onClick={handleSearch}>Search</button>
                        </div>
                        <div className="postsViewer">
                            <PostsViewer posts={userPosts} />
                        </div>
                    </div>
                </div>

            </div>

            <div className="footer">
                <div className="footer-text">
                    <p>Copyright &copy; 2023 by Supwils | All Rights Reserved.</p>
                </div>

                <div className="footer-iconTop">
                    <a href="#home"><i className='bx bx-up-arrow-alt'></i></a>
                </div>
            </div>


        </div>
    );
};
export default MainPage;

