import axios from "axios";
import { baseUrl } from "../backend.js";
const userKey = localStorage.getItem('username');
async function getUserEmail(){
    try{
        const response = await axios.get(baseUrl +"email", { withCredentials: true });
        return response.data.email;
    }
    catch(error){
        console.log("Error in getUserEmail");
    }

}
async function getUserPhone(){
    try{
        const response = await axios.get(baseUrl+"phone", { withCredentials: true });
        return response.data.phone;
    }
    catch(error){
        console.log("Error in getUserPhone");
    }

}
async function getUserZipcode(){
    try{
        const response = await axios.get(baseUrl+"zipcode",  { withCredentials: true });
        return response.data.zipcode;
    }
    catch(error){
        console.log("Error in getUserZipcode");
    }
}

async function getUserHeadline(){
    try{
        const response = await axios.get(baseUrl+"headline",  { withCredentials: true });
        return response.data.headline;
    }
    catch(error){
        console.log("Error in getUserHeadline");
    }

}
async function getUserArticles(){
    try{
        // const response = await axios.get(baseUrl+"articles",  { withCredentials: true });
        // let articles = response.data.articles;
        const response2 = await axios.get(baseUrl+"following",  { withCredentials: true });
        const following = response2.data.following;
        // for (const follow of following){
        //      const response3 = await axios.get(baseUrl+"articles/"+follow,  { withCredentials: true });
        //      articles = articles.concat(response3.data.articles);
        // }

        let usernameString = following.join(',');
        usernameString = usernameString + ',' + userKey;

        //console.log(usernameString);
        const response = await axios.get(baseUrl + `getArticlesInOneRequest?usernames=${encodeURIComponent(usernameString)}`, { withCredentials: true });
        let articles = response.data.articles;
        //console.log(articles);
        return articles;
    }
    catch(error){
        console.log("Error in getUserArticles");
    }

}

async function getUserPassword(){
    try{
        const response = await axios.get(baseUrl+"password",  { withCredentials: true });
        return response.data.password;
    }
    catch(error){
        console.log("Error in getPassword");
    }

}

async function getUserAvatar(){
    try{
        const response = await axios.get(baseUrl+"avatar",  { withCredentials: true });
        return response.data.avatar;
    }
    catch(error){
        console.log("Error in getUserAvatar");
    }

}

async function getUserFollowing(){
    try{
        const followUserInfo = [];
        const response = await axios.get(baseUrl+"following",  { withCredentials: true });
        const following = response.data.following;
        for (const follow of following){
            const response2 = await axios.get(baseUrl+"followinfo/"+follow,  { withCredentials: true });
            followUserInfo.push(response2.data);
        }
        return followUserInfo;
    }
    catch(error){
        console.log("Error in getUserFollower");
    }


}
export { getUserEmail, getUserPhone, getUserZipcode, getUserHeadline , getUserArticles, getUserPassword,getUserAvatar,getUserFollowing};