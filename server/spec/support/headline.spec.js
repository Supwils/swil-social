const axios = require('axios');
const baseUrl = 'http://localhost:8888'; 

describe('Headline API', () => {
    it('log in a user and update headline', async () => {
            const user = {
              username: 'testUser1',
              password: '123'
            };
            const headline = {
              headline: 'new headline'
            }
            const response = await axios.post(`${baseUrl}/login`, user);
            expect(response.status).toBe(200);
            const cookie = response.headers['set-cookie']; 
            const response2 = await axios.put(`${baseUrl}/headline`, headline,{
                headers: { 'Cookie': cookie }
            } )
            expect(response2.status).toBe(200);
            

    });
    it('log in a user and update headline', async () => {
      const user = {
        username: 'Supwils',
        password: 'supwils'
      };
      const headline = {
        headline: 'Update headline hello'
      }
      const response = await axios.post(`${baseUrl}/login`, user);
      expect(response.status).toBe(200);
      const cookie = response.headers['set-cookie']; 
      const response2 = await axios.put(`${baseUrl}/headline`, headline,{
          headers: { 'Cookie': cookie }
      } )
      expect(response2.status).toBe(200);
      

});

});