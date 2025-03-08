const axios = require('axios');
const baseUrl = 'http://localhost:8888'; // Replace with the appropriate URL if different

describe('Auth API', () => {
  describe('Login', () => {
    it('should log in an existing user with correct credentials', async () => {
      const user = {
        username: 'testUser1',
        password: '123'
      };
      
      const response = await axios.post(`${baseUrl}/login`, user);
      expect(response.status).toBe(200);
      //expect(response.data.username).toBe(user.username);
      expect(response.data.result).toBe('success');
    });
    it('should log in an existing user with correct credentials', async () => {
      const user = {
        username: 'test3',
        password: 'test3'
      };
      
      const response = await axios.post(`${baseUrl}/login`, user);
      expect(response.status).toBe(200);
      expect(response.data.username).toBe(user.username);
      expect(response.data.result).toBe('success');

    });
    it('should not log in a user with incorrect credentials', async () => {
      const user = {
        username: 'test3',
        password: 'wrongpassword'
      };

      try {
        await axios.post(`${baseUrl}/login`, user);
        fail('Expected server to return an error for wrong credentials');
      } catch (error) {
        expect(error.response.status).toBe(401);
      }
    });

    it('should log in an existing user and then logout', (done) => {
      const user = {
        username: 'testUser1',
        password: '123'
      };
      
      axios.post(`${baseUrl}/login`, user)
            .then(response => {
                expect(response.status).toBe(200);

                // Extract the cookie from the response
                const cookie = response.headers['set-cookie'][0];

                // Make a logout request with the extracted cookie
                return axios.put(`${baseUrl}/logout`, null, {
                    headers: { 'Cookie': cookie }
                });
            })
            .then(logoutResponse => {
                expect(logoutResponse.status).toBe(200); // Assuming 200 is the expected status for successful logout
                done(); // Indicate test completion
            })
            .catch(error => {
                fail(error.message); // Explicitly fail the test on error
                done(); // Indicate test completion
            });
    });

  });


  describe('Register', () => {
    it('should register a new test user', async () => {
      const user = {
        username: 'testUser',
        password: '123',
      }
      try{
        const response = await axios.post(`${baseUrl}/register`, user);
        expect(response.status).toBe(200);
      }
      catch(error){
        console.log(error)
      }
      
    });

  });

});
