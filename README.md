# DadHatHub Backend

This is the backend for the **DadHatHub** web application. It serves as a bridge between the frontend, the Printful API (for product management and fulfillment), and the Stripe API (for payment processing).

---

## Features

### Printful Integration
- **Fetch All Products**: Retrieves products from Printful and includes details like price, variants, and images.
- **Fetch Product Details**: Provides detailed information for a specific product by ID.

### Stripe Integration
- **Webhook Handling**: Processes Stripe webhook events to handle payments and order updates.
- **Checkout Session**: Creates checkout sessions for orders, handling items, customer information, and payment.

### Order Management
- Processes completed Stripe sessions into Printful orders with customer and product details.

---

## API Endpoints

### Printful Endpoints
- `GET /api/products`: Returns a list of all products with details.
- `GET /api/products/:id`: Returns details for a specific product.

### Stripe Endpoints
- `POST /api/stripe/create-checkout-session`: Creates a Stripe checkout session for the shopping cart.
- `POST /webhook`: Processes Stripe webhook events (e.g., `checkout.session.completed`).

---

## Getting Started

### Prerequisites
- Node.js installed on your machine.
- A `.env` file with the following keys:
  ```env
  PORT=5000
  STRIPE_SECRET_KEY=your-stripe-secret-key
  PRINTFUL_API_KEY=your-printful-api-key
  STRIPE_WEBHOOK_SECRET=your-stripe-webhook-secret

### Installation
    git clone https://github.com/your-repo-url.git
    cd dadhathub-backend
    npm install
    npm start


## How It Works

### Products
- The backend fetches product data from Printful and enriches it with additional details like prices and preview images.
- These details are served to the frontend through RESTful API endpoints.

### Checkout
- Users add items to their cart and initiate checkout.
- A Stripe session is created with product details, customer email, and shipping options.

### Order Fulfillment
- Upon payment completion, Stripe webhook events trigger backend logic to create an order in Printful with customer and product details.

---

## Dependencies
- **Express**: Web framework for creating the API.
- **Axios**: For interacting with the Printful API.
- **Stripe**: For payment processing.
- **dotenv**: For environment variable management.
- **cors**: To enable cross-origin requests.

---

## Deployment
The server can be deployed to platforms like Heroku or Vercel. Ensure environment variables are configured correctly in the hosting platform's settings.