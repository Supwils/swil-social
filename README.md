# **Full-Stack Web Social**  
A full-stack web application for social networking, featuring a **React frontend** and a **Node.js/Express backend**.

---

![Screenshot 2025-03-08 at 1 41 16 AM](https://github.com/user-attachments/assets/bf579538-e095-4842-aeb7-12496f3787c1)



## **🚀 Features**  
- User authentication and profile management  
- Post creation, editing, and deletion  
- Follow/unfollow functionality  
- Real-time notifications and interactions  
- Secure RESTful APIs with authentication  
- Optimized database operations using MongoDB  

---

## **🛠️ Tech Stack**  
### **Frontend (Client)**  
- React.js  
- Next.js  
- TailwindCSS  
- Axios  

### **Backend (Server)**  
- Node.js  
- Express.js  
- MongoDB  
- JWT Authentication  
- Cloudinary (for image uploads)  

---

## **📂 Project Structure**  
/Full-Stack-Web-Social
├── client # Frontend (React, Next.js)
└── server # Backend (Node.js, Express)

---

## **🔧 Installation & Setup**  
### **1️⃣ Clone the Repository**  
```sh
git clone https://github.com/Supwils/Full-Stack-Web-Social.git
cd Full-Stack-Web-Social
```

2️⃣ Install Dependencies
Client Server Setup
```
cd client
npm install
npm start
cd server
npm install
node index.js
```

💡 Usage
Register/Login to create a user profile

Create and interact with posts

Follow and engage with other users

Real-time updates for posts and interactions

📜 Environment Variables
Create a .env file in the server/ folder:

```
MONGO_URI=your-mongodb-uri
JWT_SECRET=your-secret-key
CLOUDINARY_URL=your-cloudinary-url
```

🤝 Contributing
Contributions are welcome!

Fork the repo

Create a new branch: git checkout -b feature-name

Commit changes: git commit -m "Added a new feature"

Push: git push origin feature-name

Open a pull request

