const fetch = require('node-fetch');
const FormData = require('form-data');
const multipart = require('parse-multipart-data');

// Rate limit storage (in-memory)
const rateLimitStore = new Map();

// Clean up old entries setiap 1 jam
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitStore.entries()) {
    if (now - data.resetTime > 0) {
      rateLimitStore.delete(ip);
    }
  }
}, 3600000);

function getRateLimitInfo(ip) {
  const now = Date.now();
  const data = rateLimitStore.get(ip);
  
  if (!data || now > data.resetTime) {
    const resetTime = now + (24 * 60 * 60 * 1000);
    const newData = {
      count: 0,
      resetTime: resetTime,
      resetDate: new Date(resetTime).toISOString()
    };
    rateLimitStore.set(ip, newData);
    return newData;
  }
  
  return data;
}

function incrementRateLimit(ip) {
  const data = getRateLimitInfo(ip);
  data.count += 1;
  rateLimitStore.set(ip, data);
  return data;
}

exports.handler = async (event, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // Get client IP
  const ip = event.headers['client-ip'] || 
             event.headers['x-forwarded-for']?.split(',')[0] || 
             event.headers['x-real-ip'] || 
             'unknown';

  // Handle GET request untuk cek rate limit
  if (event.httpMethod === 'GET') {
    const limitInfo = getRateLimitInfo(ip);
    const remaining = Math.max(0, 100 - limitInfo.count);
    
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        limit: 100,
        remaining: remaining,
        used: limitInfo.count,
        resetAt: limitInfo.resetDate,
        resetIn: Math.max(0, Math.floor((limitInfo.resetTime - Date.now()) / 1000))
      })
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Check rate limit
    const limitInfo = getRateLimitInfo(ip);
    
    if (limitInfo.count >= 100) {
      const resetIn = Math.floor((limitInfo.resetTime - Date.now()) / 1000);
      const hours = Math.floor(resetIn / 3600);
      const minutes = Math.floor((resetIn % 3600) / 60);
      
      return {
        statusCode: 429,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'Rate limit exceeded',
          message: `Limit harian tercapai! Coba lagi dalam ${hours}j ${minutes}m`,
          limit: 100,
          remaining: 0,
          resetAt: limitInfo.resetDate,
          resetIn: resetIn
        })
      };
    }

    // Parse multipart form data
    const contentType = event.headers['content-type'];
    if (!contentType || !contentType.includes('multipart/form-data')) {
      return {
        statusCode: 400,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'Content-Type must be multipart/form-data' })
      };
    }

    const boundary = contentType.split('boundary=')[1];
    const bodyBuffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
    const parts = multipart.parse(bodyBuffer, boundary);

    let imageData = null;
    let username = null;
    let imageName = 'image.jpg';

    for (const part of parts) {
      if (part.name === 'image') {
        imageData = part.data;
        imageName = part.filename || 'image.jpg';
      } else if (part.name === 'username') {
        username = part.data.toString('utf8');
      }
    }

    // Validation
    if (!imageData || imageData.length === 0) {
      return {
        statusCode: 400,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'Gambar tidak ditemukan!' })
      };
    }

    if (!username) {
      return {
        statusCode: 400,
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'Username tidak boleh kosong!' })
      };
    }

    // Create form data for external API
    const formData = new FormData();
    formData.append('image', imageData, { filename: imageName });
    formData.append('username', username);

    // Call external API
    const response = await fetch('https://api.zenzxz.my.id/api/maker/fakeml', {
      method: 'POST',
      body: formData,
      headers: formData.getHeaders()
    });

    if (!response.ok) {
      throw new Error('External API error');
    }

    // Increment rate limit setelah sukses
    const updatedLimit = incrementRateLimit(ip);
    const remaining = Math.max(0, 100 - updatedLimit.count);

    // Get image buffer
    const resultBuffer = await response.buffer();

    // Return image langsung (browser yang handle download)
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="FakeML_${username}_${Date.now()}.png"`,
        'X-RateLimit-Limit': '100',
        'X-RateLimit-Remaining': remaining.toString(),
        'X-RateLimit-Reset': updatedLimit.resetDate,
        'Cache-Control': 'no-cache'
      },
      body: resultBuffer.toString('base64'),
      isBase64Encoded: true
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Gagal generate gambar',
        message: error.message || 'Terjadi kesalahan pada server'
      })
    };
  }
};
