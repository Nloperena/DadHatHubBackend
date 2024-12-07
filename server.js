const express = require('express');
const axios = require('axios');
const cors = require('cors');
const dotenv = require('dotenv');
const stripe = require('stripe');

// Load environment variables
dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

// Stripe initialization
const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);

// Printful API key
const PRINTFUL_API_KEY = process.env.PRINTFUL_API_KEY;

// Middleware
app.use(cors());
// Do not apply express.json() and express.urlencoded() globally here
// They will be applied after the webhook route

// Stripe webhook endpoint secret
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

/**
 * Webhook endpoint to handle Stripe events.
 * Must be defined before body parsing middleware.
 */
// Webhook endpoint
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    // Validate and construct the Stripe event
    event = stripeClient.webhooks.constructEvent(req.body, sig, endpointSecret);
    console.log('Webhook Verified:', event);

    // Handle specific event types
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('Payment successful:', session);
      handleCheckoutSessionCompleted(session);
    } else {
      console.log(`Unhandled event type: ${event.type}`);
    }

    res.status(200).send('Webhook received!');
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Apply JSON parsing middleware only AFTER the webhook route
app.use(express.json());
app.use(express.urlencoded({ extended: true }));



// Apply body parsing middleware for other routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Fetch all products from Printful.
 */
app.get('/api/products', async (req, res) => {
  try {
    const response = await axios.get('https://api.printful.com/store/products', {
      headers: { Authorization: `Bearer ${PRINTFUL_API_KEY}` },
    });

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

    res.status(200).json({ products: detailedProducts });
  } catch (error) {
    console.error('Error fetching products from Printful:', error.message);
    res.status(500).json({ error: 'Failed to fetch products.' });
  }
});

/**
 * Fetch specific product details by ID from Printful.
 */
app.get('/api/products/:id', async (req, res) => {
  const productId = req.params.id;
  console.log(`Fetching product with ID: ${productId}`);

  try {
    const response = await axios.get(`https://api.printful.com/store/products/${productId}`, {
      headers: { Authorization: `Bearer ${PRINTFUL_API_KEY}` },
    });

    const product = response.data.result;

    const productDetails = {
      id: product.sync_product.id, // Correctly map product ID
      name: product.sync_product.name, // Correctly map product name
      description: product.sync_product.description || 'No description available',
      thumbnail_url: product.sync_product.thumbnail_url,
      variants: product.sync_variants.map((variant) => ({
        id: variant.id,
        name: variant.name, // Only variant name
        price: parseFloat(variant.retail_price) * 100,
        thumbnail_url: variant.files?.find((file) => file.type === 'preview')?.preview_url || null,
      })),
    };

    console.log('Processed Product Details:', productDetails); // Debug log
    res.status(200).json(productDetails);
  } catch (error) {
    console.error(`Error fetching product with ID ${productId}:`, error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Create Stripe Checkout session.
 */
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  const { cart, customerInfo } = req.body;

  try {
    const lineItems = cart.map((item) => ({
      price_data: {
        currency: 'usd',
        product_data: {
          name: item.name,
          images: [item.thumbnail_url],
          metadata: {
            variant_id: item.variant_id,
            product_id: item.id,
          },
        },
        unit_amount: item.price,
      },
      quantity: item.quantity,
    }));

    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: customerInfo.email,
      success_url: `http://localhost:3000/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `http://localhost:3000/cancel`,
      shipping_address_collection: {
        allowed_countries: ['US', 'CA'],
      },
      billing_address_collection: 'required',
    });

    res.status(200).json({ id: session.id });
  } catch (error) {
    console.error('Stripe Checkout Session Error:', error);
    res.status(500).json({
      error: 'Failed to create Stripe session.',
      details: error.message,
    });
  }
});

/**
 * Handle successful Stripe checkout sessions.
 */
async function handleCheckoutSessionCompleted(session) {
  try {
    const checkoutSession = await stripeClient.checkout.sessions.retrieve(session.id, {
      expand: ['line_items.data.price.product'],
    });

    const orderItems = checkoutSession.line_items.data
      .map((item) => {
        const variantId = item.price.product.metadata.variant_id;
        const productId = item.price.product.metadata.product_id;

        if (!variantId || !productId) {
          console.error('Missing variant_id or product_id for item:', item);
          return null;
        }
        return {
          sync_variant_id: variantId,
          quantity: item.quantity,
        };
      })
      .filter(Boolean);

    if (orderItems.length === 0) {
      throw new Error('No valid items for Printful order.');
    }

    if (!session.customer_details) {
      throw new Error('Missing customer details in session.');
    }

    const orderData = {
      recipient: {
        name: session.customer_details.name || 'No Name',
        address1: session.customer_details.address.line1,
        city: session.customer_details.address.city,
        state_code: session.customer_details.address.state,
        country_code: session.customer_details.address.country,
        zip: session.customer_details.address.postal_code,
        email: session.customer_email,
        phone: session.customer_details.phone || '',
      },
      items: orderItems,
    };

    const response = await axios.post('https://api.printful.com/orders', orderData, {
      headers: {
        Authorization: `Bearer ${PRINTFUL_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('Printful order response:', response.data);
  } catch (error) {
    console.error('Error handling checkout session:', error.response?.data || error.message);
  }
}

/**
 * Start the server.
 */
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
