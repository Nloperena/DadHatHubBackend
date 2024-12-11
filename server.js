// This code sets up a simple Express server that talks to Stripe to create a checkout session
// and also create orders in Printful after a successful payment.
// We add console.log statements (debugging) to see what's going on and help fix problems.

const express = require('express');         // Import Express to create a web server
const axios = require('axios');             // Import Axios to make HTTP requests
const cors = require('cors');               // Import CORS to allow other sites to talk to our server
const dotenv = require('dotenv');           // Import Dotenv to load our secret keys from a .env file
const stripe = require('stripe');           // Import Stripe library for payments

dotenv.config();                            // Load environment variables from .env file
const app = express();                      // Create an Express application
const PORT = process.env.PORT || 5000;      // Use the port given by the environment or 5000 as a backup

// Set up Stripe with our secret key from environment variables
const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);
// Debug: Check if we have a Stripe secret key
console.log("Stripe secret key present:", Boolean(process.env.STRIPE_SECRET_KEY));

// Printful API key from environment
const PRINTFUL_API_KEY = process.env.PRINTFUL_API_KEY;
// Debug: Check if we have Printful API key
console.log("Printful API key present:", Boolean(PRINTFUL_API_KEY));

// Allow cross-origin requests
app.use(cors());

// Stripe webhook endpoint secret
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
// Debug: Check if we have a Stripe Webhook Secret
console.log("Stripe Webhook Secret present:", Boolean(endpointSecret));

// Webhook endpoint: Stripe calls this when something happens, like a payment finishing
// Important: Define this BEFORE using express.json() so the raw body is available
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripeClient.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('Webhook Verified:', event);

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('Payment successful:', session);

      // 1. Get line items for the session to know what was purchased
      const lineItems = await stripeClient.checkout.sessions.listLineItems(session.id, { limit: 100 });
      console.log('Line Items from Stripe:', lineItems.data);

      // 2. Build items array for Printful order from the line items metadata
      const printfulItems = lineItems.data.map((item) => {
        // We saved variant_id in product_data.metadata.variant_id when creating the session
        // In the webhook route
        const variantId = item.price.metadata.variant_id;
        return {
          variant_id: parseInt(variantId, 10), // Ensure it's a number
          quantity: item.quantity,
        };
      });

      // 3. Prepare the shipping info from the session’s customer details
      const { customer_details } = session;
      const recipient = {
        name: customer_details.name || 'No Name Provided',
        address1: customer_details.address.line1 || '',
        address2: customer_details.address.line2 || '',
        city: customer_details.address.city || '',
        state_code: customer_details.address.state || '',
        country_code: customer_details.address.country || 'US',
        zip: customer_details.address.postal_code || ''
      };

      console.log('Creating Printful order with items:', printfulItems);
      console.log('Recipient:', recipient);

      try {
        const printfulResponse = await axios.post(
          'https://api.printful.com/orders',
          {
            recipient,
            items: printfulItems,
            confirm: 1 // This line confirms the order immediately
          },
          {
            headers: { Authorization: `Bearer ${PRINTFUL_API_KEY}` }
          }
        );

        console.log('Printful order created:', printfulResponse.data);
      } catch (error) {
        console.error('Error creating Printful order:', error.message, error.response?.data);
      }

    }

    res.status(200).send('Webhook received!');
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// After defining the webhook, now we can use body parsing middleware for other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// A simple test route to confirm server is running
app.get('/', (req, res) => {
  // Respond with a friendly message
  res.send('Welcome to the DadHatHub API!');
});

// Get all products from Printful
app.get('/api/products', async (req, res) => {
  try {
    // Make a call to Printful's store products API
    const response = await axios.get('https://api.printful.com/store/products', {
      headers: { Authorization: `Bearer ${PRINTFUL_API_KEY}` },
    });

    // Debug: Show how many products we got
    console.log('Number of products fetched:', response.data.result.length);

    // For each product, get its details
    const detailedProducts = await Promise.all(
      response.data.result.map(async (product) => {
        const detailsResponse = await axios.get(
          `https://api.printful.com/store/products/${product.id}`,
          {
            headers: { Authorization: `Bearer ${PRINTFUL_API_KEY}` },
          }
        );

        const details = detailsResponse.data.result;
        const price = details.sync_variants?.[0]?.retail_price
          ? parseFloat(details.sync_variants[0].retail_price) * 100
          : 0;

        const mockupImage =
          details.sync_variants[0]?.files.find((file) => file.type === 'preview')
            ?.preview_url || product.thumbnail_url;

        return {
          id: product.id,
          name: product.name || 'No name available',
          thumbnail_url: mockupImage || 'default_image_url',
          price,
          variant_id: details.sync_variants?.[0]?.id || null,
        };
      })
    );

    // Respond with a list of products
    res.status(200).json({ products: detailedProducts });
  } catch (error) {
    // If there's an error, log it and send a server error message
    console.error('Error fetching products from Printful:', error.message);
    res.status(500).json({ error: 'Failed to fetch products.' });
  }
});

// Get details for a specific product
app.get('/api/products/:id', async (req, res) => {
  const productId = req.params.id;
  console.log(`Fetching product with ID: ${productId}`); // Debug: Show which product ID we're fetching

  try {
    const response = await axios.get(`https://api.printful.com/store/products/${productId}`, {
      headers: { Authorization: `Bearer ${PRINTFUL_API_KEY}` },
    });

    const product = response.data.result;

    const productDetails = {
      id: product.sync_product.id,
      name: product.sync_product.name,
      description: product.sync_product.description || 'No description available',
      thumbnail_url: product.sync_product.thumbnail_url,
      variants: product.sync_variants.map((variant) => ({
        id: variant.id,
        name: variant.name,
        // Multiply price by 100 to convert dollars to cents
        price: parseFloat(variant.retail_price) * 100,
        thumbnail_url: variant.files?.find((file) => file.type === 'preview')?.preview_url || null,
      })),
    };

    res.status(200).json(productDetails);
  } catch (error) {
    console.error(`Error fetching product with ID ${productId}:`, error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a Stripe Checkout session
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  const { cart, customerInfo } = req.body;

  // Debug: Log what we received from the frontend
  console.log("Received cart from frontend:", cart);
  console.log("Received customerInfo from frontend:", customerInfo);

  try {
    // Build the line items array for Stripe
    // In create-checkout-session route
    const lineItems = cart.map((item) => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          images: [item.thumbnail_url],
        },
        unit_amount: item.price,
        metadata: {
          variant_id: String(item.variant_id),
          product_id: String(item.id),
        }
      },
      quantity: item.quantity,
    }));


    // Debug: Print the line items for verification
    console.log("Line Items for Stripe:", JSON.stringify(lineItems, null, 2));

    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ['card'], // Accept card payments
      line_items: lineItems,          // Our items for checkout
      mode: 'payment',                // One-time payment mode
      customer_email: customerInfo.email, // Send email to Stripe for receipts
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`, // Where to go if payment succeeds
      cancel_url: `${process.env.FRONTEND_URL}/cancel`, // Where to go if they cancel
      shipping_address_collection: {
        allowed_countries: ['US', 'CA'], // Which countries we ship to
      },
      billing_address_collection: 'required', // Ask for billing address
    });

    // Debug: Print the session we got back from Stripe
    console.log("Created Stripe session:", session);

    // Send back the session ID so the frontend can redirect the user
    res.status(200).json({ id: session.id });
  } catch (error) {
    // If something went wrong, log the error and send back a message
    console.error('Stripe Checkout Session Error:', error);
    res.status(500).json({
      error: 'Failed to create Stripe session.',
      details: error.message,
    });
  }
});

// Start the server and listen on the chosen port
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
