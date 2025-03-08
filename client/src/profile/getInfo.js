import users from '../users.json';
function getUserName() {
    const userKey = localStorage.getItem('username');
    //if (userKey && users.some(user => user.username === userKey)) {
        return users.find(user => user.username === userKey).name;
    //}
}

function getUserEmail() {
    const userKey = localStorage.getItem('username');
    //if (userKey && users.some(user => user.username === userKey)) {
        return users.find(user => user.username === userKey).email;
   // }
}

function getUserPhone() {
    const userKey = localStorage.getItem('username');
    //if (userKey && users.some(user => user.username === userKey)) {
        return users.find(user => user.username === userKey).phone.substring(2,14);
   // }
}
function getUserZipcode(){
    const userKey = localStorage.getItem('username');
    //if (userKey && users.some(user => user.username === userKey)) {
        return users.find(user => user.username === userKey).address.zipcode.substring(0,5);
    //}
}
function getUserProImg(){
    const userKey = localStorage.getItem('username');
    //if (userKey && users.some(user => user.username === userKey)) {
        return " ";//users.find(user => user.username === userKey).image;
    //}
}
function getUserHeadline(){
    const userKey = localStorage.getItem('username');
    //if (userKey && users.some(user => user.username === userKey)) {
        return users.find(user => user.username === userKey).company.catchPhrase;
   // }
}

function getUserPassword(){
    const userKey = localStorage.getItem('username');
    //if (userKey && users.some(user => user.username === userKey)) {
        return users.find(user => user.username === userKey).address.street;
   // }
}
export { getUserName, getUserEmail, getUserPhone, getUserProImg, getUserZipcode, getUserHeadline, getUserPassword };