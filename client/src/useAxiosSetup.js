import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
const useAxiosSetup = () => {
    const history = useNavigate();

    const checkAuthTimeout = response => {
        if (response.status === 401) {
            // Clear local session data if any
            localStorage.clear();
            // Redirect to login page
            history.push('/login');
        }
        return response;
    };

    useEffect(() => {
        // Setting up Axios Interceptors
        const responseInterceptor = axios.interceptors.response.use(
            response => response, 
            checkAuthTimeout
        );

        // Cleanup the interceptor
        return () => {
            axios.interceptors.response.eject(responseInterceptor);
        };
    }, [history]);

    return null;
};
export default useAxiosSetup;