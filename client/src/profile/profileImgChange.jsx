import React, { useState, useRef } from 'react';
import axios from 'axios';
import {baseUrl} from "../backend.js";
const baseURL = baseUrl

function ImageUploadComponent() {
    const [selectedImage, setSelectedImage] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const fileInputRef = useRef(null);
    // Triggered when "Choose Image" button is clicked
    const handleChooseButtonClick = () => {
        fileInputRef.current.click();
    };

    // Called when an image file is selected
    const handleFileChange = (event) => {
        const file = event.target.files[0];
        if (file) {
            console.log('Selected image:', file);
            setSelectedImage(file);
        }
    };

    const handleUploadButtonClick = async () => {
        if (!selectedImage) {
            alert('Please choose an image');
            return;
        }

        // Optional: Validate file type and size here
        if (!selectedImage.type.startsWith('image/')) {
            alert('Please select an image file');
            return;
        }
        if (selectedImage.size > 5000000) { // 5MB size limit example
            alert('File size should be less than 5MB');
            return;
        }

        const formData = new FormData();
        formData.append('image', selectedImage);

        setIsLoading(true);
        setError(null);

        try {
            const response = await axios.put(baseURL + 'avatar', formData, {
                headers: {
                    'Content-Type': 'multipart/form-data',
                },
                withCredentials: true
            });

            console.log('Response from backend:', response.data);
            window.location.reload();
            // setSelectedImageURL(response.data.avatar); // Example

        } catch (error) {
            console.error('Error uploading image:', error);
            setError('Error uploading image');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div>
            {/* Invisible file input */}
            <input 
                type="file" 
                ref={fileInputRef} 
                style={{ display: 'none' }} 
                onChange={handleFileChange} 
            />

            {/* Button to trigger the file input */}
            <button onClick={handleChooseButtonClick}>Choose Image</button>

            {/* Button to handle the upload */}
            <button onClick={handleUploadButtonClick}>Upload</button>
            {isLoading && <div>Loading...</div>}
            {error && <div style={{ color: 'red' }}>{error}</div>}
            {/* Display the selected image name */}
            {selectedImage && <div>Selected: {selectedImage.name}</div>}
        </div>
    );
}

export default ImageUploadComponent;
