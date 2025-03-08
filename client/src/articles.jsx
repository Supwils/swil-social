// Articles.jsx
import React, { useState, useEffect } from 'react';

function Articles() {
    const [articles, setArticles] = useState([]);

    useEffect(() => {
        fetch("http://localhost:8888/articles", {
            method: "GET",
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        })
        .then(response => response.json())
        .then(data => setArticles(data))
        .catch(error => console.error("Error fetching articles:", error));
    }, []);

    return (
        <div>
            <h1>Articles</h1>
            <ul>
                {articles.map(article => (
                    <li key={article.id}>
                        <strong>{article.author}</strong>: {article.body}
                    </li>
                ))}
            </ul>
        </div>
    );
}

export default Articles;
