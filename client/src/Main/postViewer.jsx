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
    return () => window.removeEventListener('keydown', handleEscKey);
  }, [onClose]);

  return (
    <div className="image-modal-overlay" onClick={onClose}>
      <div className="image-modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="image-modal-close" onClick={onClose}>×</button>
        <img src={src} alt={alt || 'Preview'} />
      </div>
    </div>
  );
};

// Text Content Modal Component (for Read More)
const TextContentModal = ({ post, onClose }) =>
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
    return () => window.removeEventListener('keydown', handleEscKey);
  }, [onClose]);

  const formatDate = (dateString) =>
  {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  return (
    <div className="text-modal-overlay" onClick={onClose}>
      <div className="text-modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="text-modal-close" onClick={onClose}>×</button>

        <div className="text-modal-details">
          <div className="text-modal-header">
            <h3 className="text-modal-author">{post.author}</h3>
            <span className="text-modal-date">{formatDate(post.date)}</span>
          </div>
          <div className="text-modal-text">
            {post.title && <h4 className="text-modal-title">{post.title}</h4>}
            <p>{post.text}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

const PostsViewer = ({ posts }) =>
{
  const [showPreview, setShowPreview] = useState(false);
  const [previewSrc, setPreviewSrc] = useState('');
  const [comments, setComments] = useState({});
  const [showComments, setShowComments] = useState({});
  const [commentContents, setCommentContents] = useState({});
  const [editingPost, setEditingPost] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [editingComment, setEditingComment] = useState(null);
  const [editCommentContent, setEditCommentContent] = useState('');
  // State for the text content modal
  const [selectedPost, setSelectedPost] = useState(null);

  // Ensure posts is always an array
  const safePosts = Array.isArray(posts) ? posts : [];

  // Improved truncate text function to handle word count and add ellipsis naturally
  const truncateText = (text, maxWords = 50) =>
  {
    if (!text) return '';
    const words = text.split(/\s+/);
    if (words.length <= maxWords) return text;
    return words.slice(0, maxWords).join(' ') + '...';
  };

  // Calculate if post needs "Read More" button
  const needsReadMore = (text) =>
  {
    if (!text) return false;
    const words = text.split(/\s+/);
    return words.length > 50;
  };

  useEffect(() =>
  {
    // Fetch comments from the backend
    const fetchComments = async () =>
    {
      try
      {
        for (const post of safePosts)
        {
          if (post && post.id)
          {
            const response = await axios.get(`${baseUrl}/articles/${post.id}`, {
              withCredentials: true
            });

            if (response.data && response.data.articles && response.data.articles.comment)
            {
              setComments(prev => ({
                ...prev,
                [post.id]: response.data.articles.comment
              }));
            }
          }
        }
      } catch (error)
      {
        console.error('Error fetching comments:', error);
      }
    };

    fetchComments();
  }, [safePosts]);

  const handleCommentButtonClick = (postId) =>
  {
    setShowComments(prev => ({
      ...prev,
      [postId]: !prev[postId]
    }));
  };

  const handleCommentChange = (postId, value) =>
  {
    setCommentContents(prev => ({
      ...prev,
      [postId]: value
    }));
  };

  const handleImageClick = (imageSrc) =>
  {
    setPreviewSrc(imageSrc);
    setShowPreview(true);
  };

  const handleClosePreview = () =>
  {
    setShowPreview(false);
    setPreviewSrc('');
  };

  const handleEditCommentClick = (postId, comment) =>
  {
    setEditingComment(comment.id);
    setEditCommentContent(comment.text);

    // Scroll to the editing area
    setTimeout(() =>
    {
      const element = document.getElementById(`editComment-${comment.id}`);
      if (element) element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  };

  // Open the text content modal
  const handleReadMoreClick = (post) =>
  {
    setSelectedPost(post);
  };

  // Close the text content modal
  const handleCloseTextModal = () =>
  {
    setSelectedPost(null);
  };

  const submitComment = async (postId) =>
  {
    if (!commentContents[postId]) return;

    try
    {
      const response = await axios.put(
        `${baseUrl}/articles/${postId}`,
        { text: commentContents[postId], commentId: -1 },
        { withCredentials: true }
      );

      if (response.status === 200)
      {
        // Update comments state with the new comment
        setComments(prev => ({
          ...prev,
          [postId]: [...(prev[postId] || []), {
            id: response.data.id,
            author: response.data.author,
            text: commentContents[postId],
            date: new Date().toISOString()
          }]
        }));

        // Clear the comment input
        setCommentContents(prev => ({
          ...prev,
          [postId]: ''
        }));
      }
    } catch (error)
    {
      console.error('Error posting comment:', error);
    }
  };

  const startEditing = (postId, currentText) =>
  {
    setEditingPost(postId);
    setEditContent(currentText);
  };

  const submitEdit = async (postId) =>
  {
    if (!editContent) return;

    try
    {
      const response = await axios.put(
        `${baseUrl}/articles/${postId}`,
        { text: editContent },
        { withCredentials: true }
      );

      if (response.status === 200)
      {
        // Success, update the local state
        const updatedPosts = safePosts.map(post =>
          post.id === postId ? { ...post, text: editContent } : post
        );

        // Reset the editing state
        setEditingPost(null);
        setEditContent('');
      }
    } catch (error)
    {
      console.error('Error updating post:', error);
    }
  };

  const submitEditComment = async (commentId) =>
  {
    if (!editCommentContent || !editingComment) return;

    try
    {
      // Find the post ID that contains this comment
      let postId = null;
      for (const [pid, commentsList] of Object.entries(comments))
      {
        if (commentsList.some(c => c.id === commentId))
        {
          postId = pid;
          break;
        }
      }

      if (!postId) return;

      const response = await axios.put(
        `${baseUrl}/articles/${postId}`,
        { commentId, text: editCommentContent },
        { withCredentials: true }
      );

      if (response.status === 200)
      {
        // Update the comment in the local state
        setComments(prev => ({
          ...prev,
          [postId]: prev[postId].map(comment =>
            comment.id === commentId ? { ...comment, text: editCommentContent } : comment
          )
        }));

        // Reset editing state
        setEditingComment(null);
        setEditCommentContent('');
      }
    } catch (error)
    {
      console.error('Error updating comment:', error);
    }
  };

  const getUsername = (userId) =>
  {
    const user = users.find(u => u.id === userId);
    return user ? user.username : 'Unknown User';
  };

  const getAuthor = (post) =>
  {
    if (!post) return 'Unknown';
    if (typeof post.author === 'string') return post.author;
    return getUsername(post.author);
  };

  return (
    <div className="postsContainer">
      {safePosts.length === 0 ? (
        <div className="no-posts-message">No posts available.</div>
      ) : (
        safePosts.map((post) => (
          <div key={post.id || `post-${Math.random()}`} className="post">
            <div className="post-header">
              <span className="post-username">{getAuthor(post)}</span>
              <span className="post-date">{new Date(post.date).toLocaleDateString()}</span>
            </div>

            {post.title && <h3>{post.title}</h3>}

            {post.img && (
              <img
                src={post.img}
                alt={`Posted by ${getAuthor(post)}`}
                className="postImage"
                onClick={() => handleImageClick(post.img)}
              />
            )}

            <div className={`post-content ${editingPost === post.id ? 'editing' : ''}`}>
              {editingPost === post.id ? (
                <>
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="edit-textarea"
                  />
                  <button className="dynamicButton" onClick={() => submitEdit(post.id)}>Save</button>
                  <button className="dynamicButton" onClick={() => setEditingPost(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <p className="truncated-content">{truncateText(post.text)}</p>
                  {needsReadMore(post.text) && (
                    <button
                      className="read-more-button"
                      onClick={() => handleReadMoreClick(post)}
                    >
                      Read More
                    </button>
                  )}
                </>
              )}
            </div>

            <div className="post-actions">
              <button className="dynamicButton" onClick={() => handleCommentButtonClick(post.id)}>
                {showComments[post.id] ? 'Hide Comments' : 'Show Comments'}
              </button>
              {/* Only show edit button for user's own posts */}
              {post.canEdit && (
                <button className="dynamicButton" onClick={() => startEditing(post.id, post.text)}>Edit</button>
              )}
            </div>

            {showComments[post.id] && (
              <div className="commentsSection">
                <div className="commentsList">
                  {comments[post.id] && comments[post.id].length > 0 ? (
                    comments[post.id].map((comment) => (
                      <div key={comment.id} className="comment">
                        <strong>{comment.author}</strong>: {' '}
                        {editingComment === comment.id ? (
                          <div>
                            <textarea
                              id={`editComment-${comment.id}`}
                              value={editCommentContent}
                              onChange={(e) => setEditCommentContent(e.target.value)}
                              className="edit-textarea"
                            />
                            <div>
                              <button onClick={() => submitEditComment(comment.id)}>Save</button>
                              <button onClick={() => setEditingComment(null)}>Cancel</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {comment.text}
                            {comment.canEdit && (
                              <button
                                onClick={() => handleEditCommentClick(post.id, comment)}
                                style={{ marginLeft: '10px', fontSize: '0.8em' }}
                              >
                                Edit
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    ))
                  ) : (
                    <p>No comments yet</p>
                  )}
                </div>

                <div className="addComment">
                  <textarea
                    value={commentContents[post.id] || ''}
                    onChange={(e) => handleCommentChange(post.id, e.target.value)}
                    placeholder="Write a comment..."
                    className="comment-textarea"
                  />
                  <button onClick={() => submitComment(post.id)}>Post Comment</button>
                </div>
              </div>
            )}
          </div>
        ))
      )}

      {showPreview && (
        <ImageModal
          src={previewSrc}
          alt="Preview"
          onClose={handleClosePreview}
        />
      )}

      {selectedPost && (
        <TextContentModal
          post={selectedPost}
          onClose={handleCloseTextModal}
        />
      )}
    </div>
  );
};

export default PostsViewer;
