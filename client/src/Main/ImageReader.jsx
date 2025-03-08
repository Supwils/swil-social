import React, {useState} from "react";
import "./mainstyle.css"
function PostImgPreview() {
    const [imagePreview, setImagePreview] = useState("#");

    const handleImageChange = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onloadend = () => {
                setImagePreview(reader.result);
            };
            reader.readAsDataURL(file);
        }
    }
    return (
        <div className="postImage">
            <label htmlFor="postImage">Upload an image:</label>
            <input type="file" id="postImage" accept="image/*" onChange={handleImageChange} />
            <img id="previewImage" src={imagePreview} alt="Image Preview" style={{ display: imagePreview === "#" ? 'none' : 'block' }} />
        </div>
    );
};
export default PostImgPreview;