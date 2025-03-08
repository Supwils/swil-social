import React, { useState, useEffect } from 'react';
import postsData from '../posts.json';
import users from '../users.json';
import axios from 'axios';
import { baseUrl } from "../backend.js";

// Image Modal Component
const ImageModal = ({ src, alt, onClose }) =>
{
  // Close modal when Escape key is pressed
  useEffect(() =>
  {
    const handleEscKey = (event) =>
    {
      if (event.key === 'Escape')
      {
        onClose();
      }
    };

    window.addEventListener('keydown', handleEscKey);

    // Prevent scrolling when modal is open
    document.body.style.overflow = 'hidden';

    return () =>
    {
      window.removeEventListener('keydown', handleEscKey);
      document.body.style.overflow = 'auto';
    };
  }, [onClose]);

  return (
    <div className="image-modal-overlay" onClick={onClose}>
      <div className="image-modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="image-modal-close" onClick={onClose}>×</button>
        <img src={src} alt={alt} />
      </div>
    </div>
  );
};

const PostsViewer = ({ posts }) =>
{
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showCommentsForPost, setShowCommentsForPost] = useState(
    posts.reduce((acc, post) => ({ ...acc, [post.id]: true }), {}) // Initialize to show all comments
  );

  const [commentInput, setCommentInput] = useState({});
  const [showCommentInput, setShowCommentInput] = useState({});

  const userKey = localStorage.getItem('username');
  const userID = users.find(item => item['username'] === userKey)?.id;

  const [editingPostId, setEditingPostId] = useState(null);
  const [editText, setEditText] = useState({});

  const [editingCommentId, setEditingCommentId] = useState(null);
  const [editCommentText, setEditCommentText] = useState({});

  // Add state for image preview modal
  const [previewImage, setPreviewImage] = useState(null);

  useEffect(() =>
  {
    if (currentIndex < 0)
    {
      setCurrentIndex(0);
    } else if (currentIndex > posts.length - 4)
    {
      setCurrentIndex(0);
    }
  }, [currentIndex, posts.length]);

  if (posts.length === 0)
  {
    return <p>No posts available.</p>;
  }
  posts.sort((a, b) => (a.date > b.date ? -1 : 1));

  const toggleComments = postId =>
  {
    setShowCommentsForPost(prevState => ({
      ...prevState,
      [postId]: !prevState[postId]
    }));
  };

  const handleCommentButtonClick = (postId) =>
  {
    setShowCommentInput(prev => ({ ...prev, [postId]: !prev[postId] }));
  };

  const handleCommentChange = (postId, value) =>
  {
    setCommentInput(prev => ({ ...prev, [postId]: value }));
  };

  // Add handler for image click
  const handleImageClick = (imageSrc) =>
  {
    setPreviewImage(imageSrc);
  };

  // Add handler to close image preview
  const handleClosePreview = () =>
  {
    setPreviewImage(null);
  };

  const handleEditCommentClick = (postId, comment) =>
  {
    if (comment.username === userKey)
    { // Check if the logged-in user is the comment author
      setEditingCommentId(comment.id);
      setEditCommentText({ ...editCommentText, [comment.id]: comment.text });
      console.log(comment.id)
    } else
    {
      alert("You are not allowed to edit other people's comments.");
    }
  };

  const submitComment = async (postId) =>
  {
    if (!commentInput[postId] || commentInput[postId].trim() === '')
    {
      alert('Comment cannot be empty');
      return;
    }

    try
    {
      const response = await axios.put(
        baseUrl + `articles/${postId}`,
        { text: commentInput[postId] },
        { withCredentials: true }
      );

      if (response.status === 200)
      {
        // Update the local state or refresh
        window.location.reload();
      }

      // Clear the comment input
      setCommentInput(prev => ({ ...prev, [postId]: '' }));
      setShowCommentInput(prev => ({ ...prev, [postId]: false }));
    } catch (error)
    {
      alert('Failed to post comment: ' + error.message);
    }
  };

  const startEditing = (postId, currentText) =>
  {
    setEditingPostId(postId);
    setEditText({ ...editText, [postId]: currentText });
  };

  const submitEdit = async (postId) =>
  {
    if (!editText[postId] || editText[postId].trim() === '')
    {
      alert('Post content cannot be empty');
      return;
    }

    try
    {
      const response = await axios.put(
        baseUrl + `articles/${postId}`,
        { text: editText[postId] },
        { withCredentials: true }
      );

      if (response.status === 200)
      {
        // Update the local state or refresh
        window.location.reload();
      }

      setEditingPostId(null);
    } catch (error)
    {
      alert('Failed to update post: ' + error.message);
    }
  };

  // Function to submit the edited comment
  const submitEditComment = async (commentId) =>
  {
    const updatedCommentText = editCommentText[commentId];
    if (updatedCommentText)
    {
      try
      {
        // Add your API call logic here to update the comment
        console.log("Submitting edited comment:", updatedCommentText);
        setEditingCommentId(null); // Reset editing state
      } catch (error)
      {
        console.error('Error updating comment:', error);
      }
    }
  };

  // Find the username for a post
  const getUsername = (userId) =>
  {
    const user = users.find(user => user.id === userId);
    return user ? user.username : 'Unknown User';
  };

  // Get author name from post
  const getAuthor = (post) =>
  {
    return post.author || getUsername(post.userId);
  };

  // Render posts with improved styling
  return (
    <div>
      <div className="eachPosts">
        {posts.slice(currentIndex, currentIndex + 9).map(post => (
          <div key={post.id} className="post">
            <div className="post-header">
              <span className="post-username">{getAuthor(post)}</span>
              <span className="post-date">{post.date}</span>
            </div>

            {post.img && (
              <img
                src={post.img}
                alt="Post"
                className="postViewImage"
                onClick={() => handleImageClick(post.img)}
              />
            )}

            <div className="post-content">
              {editingPostId === post.id ? (
                <textarea
                  value={editText[post.id] || (post.body || post.text)}
                  onChange={e => setEditText({ ...editText, [post.id]: e.target.value })}
                  className="edit-textarea"
                />
              ) : (
                <p>{post.body || post.text}</p>
              )}
            </div>

            <div className="post-actions">
              {userID === post.userId && (
                <button className="dynamicButton" onClick={() =>
                {
                  if (editingPostId === post.id)
                  {
                    submitEdit(post.id);
                  } else
                  {
                    setEditingPostId(post.id);
                    setEditText({ ...editText, [post.id]: (post.body || post.text) });
                  }
                }}>
                  {editingPostId === post.id ? 'Save' : 'Edit'}
                </button>
              )}

              <button className="dynamicButton" onClick={() => handleCommentButtonClick(post.id)}>
                Comment
              </button>

              <button className="dynamicButton" onClick={() => toggleComments(post.id)}>
                {showCommentsForPost[post.id] ? "Hide Comments" : "Show Comments"}
              </button>
            </div>

            {showCommentInput[post.id] && (
              <div style={{ marginTop: '10px' }}>
                <textarea
                  placeholder="Add a comment..."
                  value={commentInput[post.id] || ""}
                  onChange={e => handleCommentChange(post.id, e.target.value)}
                  style={{ width: '100%', marginBottom: '5px' }}
                  className="comment-textarea"
                />
                <button
                  className="dynamicButton"
                  onClick={() => submitComment(post.id)}
                >
                  Submit
                </button>
              </div>
            )}

            {showCommentsForPost[post.id] && post.comment && post.comment.length > 0 && (
              <div className="commentsSection">
                <h4>Comments:</h4>
                {post.comment.map(comment => (
                  <div key={comment.id || comment.date} className="comment">
                    <strong>{comment.username || getUsername(comment.userId)}:</strong>
                    {editingCommentId === comment.id ? (
                      <>
                        <textarea
                          value={editCommentText[comment.id] || comment.text}
                          onChange={e => setEditCommentText({ ...editCommentText, [comment.id]: e.target.value })}
                          style={{ width: '100%', marginTop: '5px' }}
                          className="comment-textarea"
                        />
                        <button
                          className="dynamicButton"
                          onClick={() =>
                          {
                            // Implement comment edit submission logic
                          }}
                        >
                          Save
                        </button>
                      </>
                    ) : (
                      <>
                        <p>{comment.text}</p>
                        {(userKey === comment.username || userID === comment.userId) && (
                          <button
                            className="dynamicButton"
                            onClick={() =>
                            {
                              setEditingCommentId(comment.id);
                              setEditCommentText({ ...editCommentText, [comment.id]: comment.text });
                            }}
                          >
                            Edit
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="navigationButtons">
        <button className="dynamicButton" onClick={() => setCurrentIndex(Math.max(0, currentIndex - 3))}>Previous</button>
        <button className="dynamicButton" onClick={() => setCurrentIndex(Math.min(posts.length - 1, currentIndex + 3))}>Next</button>
      </div>

      {/* Image Preview Modal */}
      {previewImage && (
        <ImageModal
          src={previewImage}
          alt="Preview"
          onClose={handleClosePreview}
        />
      )}
    </div>
  );
};

export default PostsViewer;
