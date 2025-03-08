const axios = require('axios');
const baseUrl = 'http://localhost:8888'; 

describe('Article API', () => {
    it('log in a user and add an article', (done) => {
      const user = {
        username: 'testUser1',
        password: '123'
      };
      const article = {
        text: 'test article'
      };
  
      axios.post(`${baseUrl}/login`, user)
        .then(response => {
          expect(response.status).toBe(200);
          const cookie = response.headers['set-cookie'];
          return axios.post(`${baseUrl}/articles/`, article, {
            headers: { 'Cookie': cookie }
          });
        })
        .then(response2 => {
          expect(response2.status).toBe(201);
          done(); // Indicate test completion
        })
        .catch(error => {
          fail(error); // Explicitly fail the test on error
          done(); // Indicate test completion
        });
    });
    it('log in a user and get articles', (done) => {
        const user = {
          username: 'testUser1',
          password: '123'
        };
        const article = {
          text: 'test article'
        };
    
        axios.post(`${baseUrl}/login`, user)
          .then(response => {
            expect(response.status).toBe(200);
            const cookie = response.headers['set-cookie'];
            return axios.get(`${baseUrl}/articles/`, {
              headers: { 'Cookie': cookie }
            });
          })
          .then(response2 => {
            expect(response2.status).toBe(200);
            done(); // Indicate test completion
          })
          .catch(error => {
            fail(error); // Explicitly fail the test on error
            done(); // Indicate test completion
          });
      });
      it('log in a user and get articles', (done) => {
        const user = {
          username: 'Supwils',
          password: 'supwils'
        };
        const article = {
          text: 'test article'
        };
    
        axios.post(`${baseUrl}/login`, user)
          .then(response => {
            expect(response.status).toBe(200);
            const cookie = response.headers['set-cookie'];
            return axios.get(`${baseUrl}/articles/1`, {
              headers: { 'Cookie': cookie }
            });
          })
          .then(response2 => {
            expect(response2.status).toBe(200);
            done(); // Indicate test completion
          })
          .catch(error => {
            fail(error); // Explicitly fail the test on error
            done(); // Indicate test completion
          });
      });
  });
  