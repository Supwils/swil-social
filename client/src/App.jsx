import React, { useState, useEffect } from "react";
import { Routes, Route, Navigate, useNavigate } from "react-router-dom";
import Landing from "./landing/Landing";
import MainPage from "./Main/Main.jsx";
import Profile from "./profile/profile.jsx";
import useAxiosSetup from "./useAxiosSetup";

function App() {
    useAxiosSetup();
  const [isLoggedIn, setIsLoggedIn] = useState(localStorage.getItem('isLoggedIn') === 'true');

  const navigate = useNavigate(); // Hook for navigation
  useEffect(() => {
    if (isLoggedIn && window.location.pathname === '/login') {
        navigate("/main");
        window.location.reload();
    }
}, [isLoggedIn, navigate]);


  const handleLogout = () => {
    setIsLoggedIn(false);
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('username');
    localStorage.removeItem('isProfile');
    localStorage.removeItem('headline');
    navigate("/login"); // Navigate to the login page after logout
  };

  const toMain = () => {
    navigate("/main"); // Navigate to the main page
    window.location.reload();
  };

  const toProfile = () => {
    navigate("/profile"); // Navigate to the profile page
  };

  return (
    <Routes>
      <Route path="/login" element={<Landing setIsLoggedIn={setIsLoggedIn} />} />
      <Route path="/main" element={isLoggedIn ? <MainPage onLogout={handleLogout} onProfile={toProfile} /> : <Navigate to="/login" />} />
      <Route path="/profile" element={isLoggedIn ? <Profile onLogout={handleLogout} onMain={toMain} /> : <Navigate to="/login" />} />
      <Route path="*" element={<Navigate to={isLoggedIn ? "/main" : "/login"} />} />
    </Routes>
  );
}

export default App;
